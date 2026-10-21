import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  sep,
} from "node:path";

import {
  parseDesktopEntry,
  type DesktopEntry,
} from "../../domain/desktopEntry.js";
import {
  electronArchives,
  isDirectory,
  readBounded,
  type Candidate,
  type LocalApplicationHost,
} from "./LocalApplicationFiles.js";

const DESKTOP_ENTRY_MAX_BYTES = 256 * 1024;

// Shared command directories hold many programs; a clone copies only the file.
const sharedBinDirectories = (host: LocalApplicationHost): Set<string> =>
  new Set([
    "/bin",
    "/sbin",
    "/usr/bin",
    "/usr/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/snap/bin",
    "/var/lib/flatpak/exports/bin",
    join(host.homeDirectory, ".local", "bin"),
    join(host.homeDirectory, ".local/share/flatpak/exports/bin"),
  ]);

// Directories that hold one subdirectory per installed package.
const installContainers = (host: LocalApplicationHost): readonly string[] => [
  "/opt",
  "/usr/lib",
  "/usr/lib64",
  "/usr/libexec",
  "/usr/share",
  "/usr/local/lib",
  "/usr/local/share",
  join(host.homeDirectory, ".local", "share"),
];
// Shared namespaces inside a container hold many packages, so one more
// segment names the package (for example /usr/lib/jvm/<runtime>).
const SHARED_NAMESPACE = /^(?:[A-Za-z0-9_]+-linux-gnu[A-Za-z0-9_]*|jvm)$/u;

/**
 * The package directory that contains a resolved program: the first segment
 * below a known install container, otherwise the program's own directory.
 */
const installRoot = (program: string, host: LocalApplicationHost): string => {
  for (const container of installContainers(host)) {
    const inside = relative(container, program);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside))
      continue;
    const segments = inside.split(sep);
    const depth = SHARED_NAMESPACE.test(segments[0] ?? "") ? 2 : 1;
    // A program directly in the container (or namespace) has no package root.
    if (segments.length <= depth) return dirname(program);
    return join(container, ...segments.slice(0, depth));
  }
  return dirname(program);
};

const isExecutableFile = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

const resolveCommand = async (
  command: string,
  host: LocalApplicationHost,
): Promise<string | undefined> => {
  if (command.includes("/"))
    return isAbsolute(command) && (await isExecutableFile(command))
      ? command
      : undefined;
  for (const directory of (host.environment.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const path = join(directory, command);
    if (await isExecutableFile(path)) return path;
  }
  return undefined;
};

/** The program a desktop entry launches, skipping a leading `env` wrapper. */
const launchedCommand = (entry: DesktopEntry): string | undefined => {
  if (entry.tryExec !== null && entry.tryExec !== "") return entry.tryExec;
  const argv = entry.exec ?? [];
  let index = 0;
  if (basename(argv[0] ?? "") === "env") {
    index = 1;
    while (
      argv[index]?.includes("=") === true ||
      argv[index]?.startsWith("-") === true
    )
      index += 1;
  }
  return argv[index];
};

/** Installed files behind a flatpak or snap launcher, when present on disk. */
const sandboxedInstall = async (
  entry: DesktopEntry,
  executable: string | undefined,
  host: LocalApplicationHost,
): Promise<string | undefined> => {
  const flatpak = entry.keys.get("X-Flatpak");
  if (flatpak !== undefined && /^[A-Za-z0-9._-]+$/u.test(flatpak))
    for (const base of [
      "/var/lib/flatpak/app",
      join(host.homeDirectory, ".local/share/flatpak/app"),
    ]) {
      const path = join(base, flatpak, "current", "active", "files");
      if (await isDirectory(path)) return path;
    }
  if (executable?.startsWith("/snap/bin/") === true) {
    const name = basename(executable).split(".")[0] ?? "";
    const path = join("/snap", name, "current");
    if (name !== "" && (await isDirectory(path))) return path;
  }
  return undefined;
};

/** Classify one freedesktop desktop entry and resolve its installed files. */
export const desktopEntryCandidate = async (
  path: string,
  host: LocalApplicationHost,
): Promise<Candidate | undefined> => {
  let entry: DesktopEntry | null;
  try {
    const bytes = await readBounded(path, DESKTOP_ENTRY_MAX_BYTES);
    if (bytes === undefined) return undefined;
    entry = parseDesktopEntry(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  if (entry === null || entry.type !== "Application") return undefined;
  const limitations: string[] = [];
  if (entry.hidden) limitations.push("The desktop entry is marked Hidden.");
  if (entry.noDisplay)
    limitations.push("The desktop entry is marked NoDisplay.");
  const command = launchedCommand(entry);
  const executable =
    command === undefined ? undefined : await resolveCommand(command, host);
  const resolved =
    executable === undefined
      ? undefined
      : await realpath(executable).catch(() => executable);
  const sandbox = await sandboxedInstall(entry, executable, host);
  let rootPath: string | null = null;
  let rootKind: "directory" | "file" | null = null;
  if (sandbox !== undefined) {
    rootPath = sandbox;
    rootKind = "directory";
  } else if (resolved !== undefined) {
    const shared = sharedBinDirectories(host).has(dirname(resolved));
    rootPath = shared ? resolved : installRoot(resolved, host);
    rootKind = shared ? "file" : "directory";
    if (shared)
      limitations.push(
        "The program lives in a shared command directory, so only its executable file is selected; libraries and data it loads from elsewhere are not included.",
      );
  } else
    limitations.push(
      command === undefined
        ? "The desktop entry declares no program to launch."
        : `The launched program ${command} was not found as an executable file.`,
    );
  const stem = basename(path).slice(0, -".desktop".length);
  return {
    name: entry.name ?? stem,
    display_name: entry.genericName,
    bundle_identifier: entry.keys.get("X-Flatpak") ?? null,
    version: null,
    kind: "desktop-entry",
    root_path: rootPath,
    root_kind: rootKind,
    executable_path: resolved ?? null,
    source_path: path,
    electron_asar_paths:
      rootKind === "directory" && rootPath !== null
        ? await electronArchives(rootPath)
        : [],
    limitations,
    names: [
      ["Name", entry.name ?? ""],
      ...entry.localizedNames.map((value): [string, string] => [
        "Name[locale]",
        value,
      ]),
      ["desktop_file_id", stem],
      ["executable", resolved === undefined ? "" : basename(resolved)],
      ["GenericName", entry.genericName ?? ""],
    ].filter(([, value]) => value !== "") as [string, string][],
  };
};
