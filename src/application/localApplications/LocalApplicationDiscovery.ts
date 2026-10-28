import { opendir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";

import { z } from "zod";

import {
  LOCAL_APPLICATION_ENTRY_LIMIT,
  LOCAL_APPLICATION_MATCH_LIMIT,
  type LocalApplication,
  type LocalApplicationDiscovery,
  type LocalApplicationSearchRoot,
} from "../../domain/localApplications.js";
import {
  decodeAppInfoPlist,
  resolveAppBundleExecutable,
} from "../AppBundleExecutable.js";
import { desktopEntryCandidate } from "./DesktopEntryApplications.js";
import {
  electronArchives,
  isDirectory,
  readBounded,
  type Candidate,
  type LocalApplicationHost,
} from "./LocalApplicationFiles.js";

export type { LocalApplicationHost } from "./LocalApplicationFiles.js";

type Strategy = LocalApplicationSearchRoot["strategy"];

interface SearchRoot {
  readonly path: string;
  readonly strategy: Strategy;
}

// Bounds on files read while classifying one candidate.
const INFO_PLIST_MAX_BYTES = 1024 * 1024;

/** The platform's conventional application locations, in priority order. */
export const defaultSearchRoots = (
  host: LocalApplicationHost,
): SearchRoot[] => {
  const home = host.homeDirectory;
  const env = host.environment;
  const roots: SearchRoot[] = [];
  const add = (path: string | undefined, strategy: Strategy): void => {
    if (path !== undefined && path !== "" && isAbsolute(path))
      roots.push({ path, strategy });
  };
  if (host.platform === "darwin") {
    for (const path of [
      "/Applications",
      "/Applications/Utilities",
      "/System/Applications",
      "/System/Applications/Utilities",
      join(home, "Applications"),
    ])
      add(path, "macos-bundles");
  } else if (host.platform === "win32") {
    add(env.ProgramFiles, "program-directories");
    add(env["ProgramFiles(x86)"], "program-directories");
    if (env.LOCALAPPDATA !== undefined)
      add(join(env.LOCALAPPDATA, "Programs"), "program-directories");
  } else {
    const dataHome =
      env.XDG_DATA_HOME !== undefined && isAbsolute(env.XDG_DATA_HOME)
        ? env.XDG_DATA_HOME
        : join(home, ".local", "share");
    add(join(dataHome, "applications"), "desktop-entries");
    for (const directory of (
      env.XDG_DATA_DIRS || "/usr/local/share:/usr/share"
    ).split(":"))
      if (isAbsolute(directory))
        add(join(directory, "applications"), "desktop-entries");
    add("/var/lib/flatpak/exports/share/applications", "desktop-entries");
    add(
      join(home, ".local/share/flatpak/exports/share/applications"),
      "desktop-entries",
    );
    add("/var/lib/snapd/desktop/applications", "desktop-entries");
    add("/opt", "program-directories");
    add(join(home, "Applications"), "appimages");
  }
  const seen = new Set<string>();
  return roots.filter(({ path }) => !seen.has(path) && seen.add(path));
};

const normalize = (value: string): string =>
  value.normalize("NFKC").toLowerCase();

/** Find installed applications whose names contain the query. */
export const discoverLocalApplications = async (
  query: string,
  callerRoots: readonly string[] | undefined,
  host: LocalApplicationHost,
  signal?: AbortSignal,
): Promise<LocalApplicationDiscovery> => {
  const roots =
    callerRoots === undefined
      ? defaultSearchRoots(host)
      : callerRoots.map((path) => ({
          path,
          strategy: "caller-selected" as const,
        }));
  const needle = normalize(query);
  const records: LocalApplicationSearchRoot[] = [];
  const found: {
    readonly match: LocalApplication;
    readonly hidden: boolean;
  }[] = [];
  for (const root of roots) {
    signal?.throwIfAborted();
    const scan = await scanRoot(root, host, signal);
    records.push(scan.record);
    for (const candidate of scan.candidates) {
      const match = matchCandidate(candidate, needle);
      if (match !== undefined)
        found.push({ match, hidden: candidate.hidden === true });
    }
  }
  // Several declarations (for example desktop entries) can name one install;
  // keep the best-ranked one per installed root.
  const seenRoots = new Set<string>();
  const matches = found
    .sort(compareMatches)
    .map(({ match }) => match)
    .filter((match) => {
      const identity = match.root_path ?? match.source_path;
      if (seenRoots.has(identity)) return false;
      seenRoots.add(identity);
      return true;
    });
  const reasons = records.flatMap((record) =>
    record.state === "scanned" || record.state === "missing"
      ? []
      : [`${record.path}: ${record.reason ?? record.state}`],
  );
  return {
    query,
    platform: host.platform,
    roots_source:
      callerRoots === undefined ? "platform-default" : "caller-selected",
    roots: records,
    matches: matches.slice(0, LOCAL_APPLICATION_MATCH_LIMIT),
    matches_omitted: Math.max(
      0,
      matches.length - LOCAL_APPLICATION_MATCH_LIMIT,
    ),
    exact_match_count: matches.filter(({ exact }) => exact).length,
    coverage: {
      status: reasons.length === 0 ? "complete" : "partial",
      reasons,
    },
    limitations: [
      "Only the listed application locations were searched; applications installed elsewhere, portable copies and per-user locations outside them are not found.",
      "Names come from bundle metadata, desktop entries and directory names on disk; they do not prove which program an application launches or that it is the vendor's original build.",
      ...(host.platform === "win32"
        ? [
            "Windows discovery lists program directories only; registry uninstall entries, Start Menu shortcuts and Store (MSIX/AppX) packages are not read.",
          ]
        : []),
    ],
  };
};

/** Exact names first, then visible entries, then by name for a stable order. */
const compareMatches = (
  left: { readonly match: LocalApplication; readonly hidden: boolean },
  right: { readonly match: LocalApplication; readonly hidden: boolean },
): number =>
  left.match.exact !== right.match.exact
    ? left.match.exact
      ? -1
      : 1
    : Number(left.hidden) - Number(right.hidden) ||
      left.match.name.localeCompare(right.match.name, "en");

const matchCandidate = (
  candidate: Candidate,
  needle: string,
): LocalApplication | undefined => {
  let matched: string | undefined;
  let exact = false;
  for (const [field, value] of candidate.names) {
    const normalized = normalize(value);
    if (normalized === needle) {
      matched = field;
      exact = true;
      break;
    }
    if (matched === undefined && normalized.includes(needle)) matched = field;
  }
  if (matched === undefined) return undefined;
  const { names: _names, hidden: _hidden, ...application } = candidate;
  return { ...application, matched_field: matched, exact };
};

const errorCode = (cause: unknown): string =>
  cause instanceof Error && "code" in cause ? String(cause.code) : "";

const scanRoot = async (
  root: SearchRoot,
  host: LocalApplicationHost,
  signal: AbortSignal | undefined,
): Promise<{
  readonly record: LocalApplicationSearchRoot;
  readonly candidates: readonly Candidate[];
}> => {
  const candidates: Candidate[] = [];
  let entriesRead = 0;
  let truncated = false;
  const unreadable: string[] = [];
  const record = (
    state: LocalApplicationSearchRoot["state"],
    reason: string | null,
  ): LocalApplicationSearchRoot => ({
    path: root.path,
    strategy: root.strategy,
    state,
    reason,
    entries_read: entriesRead,
  });
  const visit = async (directory: string, depth: number): Promise<void> => {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      signal?.throwIfAborted();
      if (entriesRead >= LOCAL_APPLICATION_ENTRY_LIMIT) {
        truncated = true;
        break;
      }
      entriesRead += 1;
      const path = join(directory, entry.name);
      const candidate = await classifyEntry(
        path,
        entry.name,
        root.strategy,
        host,
      );
      if (candidate !== undefined) candidates.push(candidate);
      else if (
        root.strategy === "desktop-entries" &&
        depth === 0 &&
        entry.isDirectory()
      )
        // Desktop file IDs may live one directory below the root; an
        // unreadable subdirectory leaves the rest of the root searchable.
        await visit(path, depth + 1).catch((cause: unknown) => {
          signal?.throwIfAborted();
          unreadable.push(
            `${entry.name}${errorCode(cause) === "" ? "" : ` (${errorCode(cause)})`}`,
          );
        });
    }
  };
  try {
    if (!(await stat(root.path)).isDirectory())
      return { record: record("unreadable", "Not a directory."), candidates };
    await visit(root.path, 0);
  } catch (cause: unknown) {
    signal?.throwIfAborted();
    const code = errorCode(cause);
    if (code === "ENOENT" || code === "ENOTDIR")
      return { record: record("missing", null), candidates };
    return {
      record: record(
        "unreadable",
        code === ""
          ? "The directory could not be read."
          : `The directory could not be read (${code}).`,
      ),
      candidates,
    };
  }
  return {
    record: truncated
      ? record(
          "truncated",
          `Stopped after ${LOCAL_APPLICATION_ENTRY_LIMIT} entries.`,
        )
      : unreadable.length > 0
        ? record(
            "partial",
            `Subdirectories could not be read: ${unreadable.join(", ")}.`,
          )
        : record("scanned", null),
    candidates,
  };
};

/** Classify one directory entry by the root's strategy. */
const classifyEntry = async (
  path: string,
  name: string,
  strategy: Strategy,
  host: LocalApplicationHost,
): Promise<Candidate | undefined> => {
  const lower = name.toLowerCase();
  const any = strategy === "caller-selected";
  if ((any || strategy === "macos-bundles") && lower.endsWith(".app"))
    return (await isDirectory(path)) ? macosBundle(path) : undefined;
  if ((any || strategy === "desktop-entries") && lower.endsWith(".desktop"))
    return desktopEntryCandidate(path, host);
  if ((any || strategy === "appimages") && lower.endsWith(".appimage"))
    return fileCandidate(path, "appimage", name.slice(0, -".appimage".length));
  if ((any || strategy === "program-directories") && (await isDirectory(path)))
    return programDirectory(path);
  return undefined;
};

/** Classify one caller-selected application path. */
export const classifyApplicationPath = async (
  path: string,
  host: LocalApplicationHost,
): Promise<Candidate | undefined> => {
  const name = basename(path);
  const lower = name.toLowerCase();
  if (await isDirectory(path))
    return lower.endsWith(".app") ? macosBundle(path) : programDirectory(path);
  if (lower.endsWith(".desktop")) return desktopEntryCandidate(path, host);
  try {
    if (!(await stat(path)).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return lower.endsWith(".appimage")
    ? fileCandidate(path, "appimage", name.slice(0, -".appimage".length))
    : fileCandidate(path, "executable", name);
};

const bundleInfoSchema = z.looseObject({
  CFBundleName: z.string().optional(),
  CFBundleDisplayName: z.string().optional(),
  CFBundleIdentifier: z.string().optional(),
  CFBundleShortVersionString: z.string().optional(),
});

const macosBundle = async (path: string): Promise<Candidate> => {
  const limitations: string[] = [];
  let info: z.output<typeof bundleInfoSchema> = {};
  try {
    const bytes = await readBounded(
      join(path, "Contents", "Info.plist"),
      INFO_PLIST_MAX_BYTES,
    );
    if (bytes === undefined)
      limitations.push(
        "Contents/Info.plist exceeds the 1 MiB metadata bound and was not read.",
      );
    else {
      const parsed = bundleInfoSchema.safeParse(decodeAppInfoPlist(bytes));
      if (parsed.success) info = parsed.data;
      else
        limitations.push(
          "Contents/Info.plist is not a dictionary of bundle metadata.",
        );
    }
  } catch (cause: unknown) {
    limitations.push(
      `Contents/Info.plist could not be read${errorCode(cause) === "" ? "" : ` (${errorCode(cause)})`}.`,
    );
  }
  const executable = await resolveAppBundleExecutable(path);
  if (!executable.ok)
    limitations.push(
      `Bundle program file unresolved: ${executable.error.message}`,
    );
  const directoryName = basename(path).slice(0, -".app".length);
  const root = await realpath(path).catch(() => path);
  return {
    name: info.CFBundleName ?? directoryName,
    display_name: info.CFBundleDisplayName ?? null,
    bundle_identifier: info.CFBundleIdentifier ?? null,
    version: info.CFBundleShortVersionString ?? null,
    kind: "macos-app-bundle",
    root_path: root,
    root_kind: "directory",
    executable_path: executable.ok ? executable.value.executable : null,
    source_path: path,
    electron_asar_paths: await electronArchives(root),
    limitations,
    names: [
      ["CFBundleDisplayName", info.CFBundleDisplayName ?? ""],
      ["CFBundleName", info.CFBundleName ?? ""],
      ["bundle_directory", directoryName],
      ["CFBundleIdentifier", info.CFBundleIdentifier ?? ""],
    ].filter(([, value]) => value !== "") as [string, string][],
  };
};

const programDirectory = async (path: string): Promise<Candidate> => {
  const root = await realpath(path).catch(() => path);
  return {
    name: basename(path),
    display_name: null,
    bundle_identifier: null,
    version: null,
    kind: "program-directory",
    root_path: root,
    root_kind: "directory",
    executable_path: null,
    source_path: path,
    electron_asar_paths: await electronArchives(root),
    limitations: [],
    names: [["directory", basename(path)]],
  };
};

const fileCandidate = async (
  path: string,
  kind: "appimage" | "executable",
  name: string,
): Promise<Candidate> => ({
  name,
  display_name: null,
  bundle_identifier: null,
  version: null,
  kind,
  root_path: await realpath(path).catch(() => path),
  root_kind: "file",
  executable_path: path,
  source_path: path,
  electron_asar_paths: [],
  limitations: [],
  names: [["file_name", name]],
});
