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
// Directories that hold a package's programs rather than name the package.
const PROGRAM_DIRECTORY =
  /^(?:bin|sbin|program|programs|libexec|x86_64|x64|amd64|arm64|aarch64)$/iu;

/**
 * The package directory that contains a resolved program, below a known
 * install container: the program's own directory, or its parent while that
 * directory is a generic program directory such as `bin` or `program`. A
 * vendor directory (for example /opt/google) may hold several products, so
 * it is never selected for a program in one of its subdirectories. Anywhere
 * else the directory around the program may hold unrelated software, so only
 * the program file is selected.
 */
const installRoot = (
  program: string,
  host: LocalApplicationHost,
): { readonly path: string; readonly kind: "directory" | "file" } => {
  for (const container of installContainers(host)) {
    const inside = relative(container, program);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside))
      continue;
    const segments = inside.split(sep);
    const depth = SHARED_NAMESPACE.test(segments[0] ?? "") ? 2 : 1;
    // A program directly in the container (or namespace) has no package root.
    if (segments.length <= depth) return { path: program, kind: "file" };
    const directory = segments.slice(0, -1);
    while (
      directory.length > depth &&
      PROGRAM_DIRECTORY.test(directory.at(-1) ?? "")
    )
      directory.pop();
    return { path: join(container, ...directory), kind: "directory" };
  }
  return { path: program, kind: "file" };
};

const isExecutableFile = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

const isRegularFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

// A desktop session looks Exec programs up in PATH; without one, use the
// same default search path as Node and process capture.
const resolveCommand = async (
  command: string,
  host: LocalApplicationHost,
): Promise<string | undefined> => {
  if (command.includes("/"))
    return isAbsolute(command) && (await isExecutableFile(command))
      ? command
      : undefined;
  for (const directory of (host.environment.PATH ?? "/usr/bin:/bin").split(
    delimiter,
  )) {
    if (!isAbsolute(directory)) continue;
    const path = join(directory, command);
    if (await isExecutableFile(path)) return path;
  }
  return undefined;
};

// Interpreters and runtimes whose installed application is a file argument.
const INTERPRETER =
  /^(?:sh|bash|dash|zsh|ksh|python[0-9.]*|pypy[0-9.]*|perl[0-9.]*|ruby[0-9.]*|node|nodejs|java|mono|wine|wine64|gjs|lua[0-9.]*|php[0-9.]*)$/u;

/** What a desktop entry launches, skipping a leading `env` wrapper. */
type LaunchedProgram =
  | { readonly kind: "program"; readonly command: string }
  | {
      readonly kind: "script";
      readonly interpreter: string;
      readonly path: string;
    }
  | { readonly kind: "inline"; readonly interpreter: string }
  | { readonly kind: "none" };

const launchedProgram = (entry: DesktopEntry): LaunchedProgram => {
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
  const command = argv[index];
  if (command !== undefined && INTERPRETER.test(basename(command))) {
    // The first absolute file argument is the application (a script or jar);
    // an inline command (`sh -c "..."`) names no installed file.
    const file = argv
      .slice(index + 1)
      .find((argument) => !argument.startsWith("-") && isAbsolute(argument));
    return file === undefined
      ? { kind: "inline", interpreter: command }
      : { kind: "script", interpreter: command, path: file };
  }
  if (entry.tryExec !== null && entry.tryExec !== "")
    return { kind: "program", command: entry.tryExec };
  return command === undefined
    ? { kind: "none" }
    : { kind: "program", command };
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
  const launched = launchedProgram(entry);
  const command =
    launched.kind === "program"
      ? launched.command
      : launched.kind === "script"
        ? launched.path
        : undefined;
  const executable =
    launched.kind === "program"
      ? await resolveCommand(launched.command, host)
      : launched.kind === "script" && (await isRegularFile(launched.path))
        ? launched.path
        : undefined;
  if (launched.kind === "script" && executable !== undefined)
    limitations.push(
      `The desktop entry runs ${basename(launched.interpreter)} on ${launched.path}; that file's install is selected, not the interpreter.`,
    );
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
    const root = sharedBinDirectories(host).has(dirname(resolved))
      ? undefined
      : installRoot(resolved, host);
    rootPath = root?.path ?? resolved;
    rootKind = root?.kind ?? "file";
    if (root === undefined)
      limitations.push(
        "The program lives in a shared command directory, so only its executable file is selected; libraries and data it loads from elsewhere are not included.",
      );
    else if (root.kind === "file")
      limitations.push(
        "The program is not inside a package directory under a known install location, so only its executable file is selected; pass the install directory as an absolute path to copy it.",
      );
  } else
    limitations.push(
      launched.kind === "inline"
        ? `The desktop entry runs an inline ${basename(launched.interpreter)} command that names no installed program file.`
        : command === undefined
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
    hidden: entry.hidden || entry.noDisplay,
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
