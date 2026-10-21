/** Facts from the `[Desktop Entry]` group of one freedesktop desktop entry. */
export interface DesktopEntry {
  readonly type: string | null;
  readonly name: string | null;
  /** Values of `Name[locale]` keys, in source order. */
  readonly localizedNames: readonly string[];
  readonly genericName: string | null;
  /** Exec arguments with field codes removed, or null when absent or malformed. */
  readonly exec: readonly string[] | null;
  readonly tryExec: string | null;
  readonly hidden: boolean;
  readonly noDisplay: boolean;
  /** Raw values of every key in the group, for keys such as X-Flatpak. */
  readonly keys: ReadonlyMap<string, string>;
}

const GROUP = /^\[([^\]]*)\]$/u;
const ENTRY = /^([A-Za-z0-9-]+(?:\[[^\]]+\])?)\s*=\s*(.*)$/u;

// Desktop Entry Specification 1.5, "Possible value types": string escapes.
const unescapeString = (value: string): string =>
  value.replace(/\\(.)/gu, (match, character: string) => {
    switch (character) {
      case "s":
        return " ";
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "\\":
        return "\\";
      default:
        return match;
    }
  });

const isTrue = (value: string | undefined): boolean => value === "true";

/**
 * Split an Exec value into arguments following the specification's quoting
 * rules, then drop field codes. Returns null for unterminated quotes.
 */
export const parseDesktopExec = (value: string): string[] | null => {
  const argumentsList: string[] = [];
  let current = "";
  let started = false;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (quoted) {
      if (character === "\\" && /["`$\\]/u.test(value[index + 1] ?? "")) {
        current += value[index + 1];
        index += 1;
      } else if (character === '"') quoted = false;
      else current += character;
      continue;
    }
    if (character === '"') {
      quoted = true;
      started = true;
    } else if (character === " " || character === "\t") {
      if (started) argumentsList.push(current);
      current = "";
      started = false;
    } else {
      current += character;
      started = true;
    }
  }
  if (quoted) return null;
  if (started) argumentsList.push(current);
  return argumentsList.flatMap((argument) => {
    // A deprecated or file field code on its own is not part of the command.
    if (/^%[fFuUdDnNickvm]$/u.test(argument)) return [];
    return [
      argument.replace(/%([%fFuUdDnNickvm])/gu, (_, code: string) =>
        code === "%" ? "%" : "",
      ),
    ];
  });
};

/** Parse one desktop entry file; null when it has no `[Desktop Entry]` group. */
export const parseDesktopEntry = (text: string): DesktopEntry | null => {
  const keys = new Map<string, string>();
  let group: string | null = null;
  let found = false;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = GROUP.exec(line);
    if (header !== null) {
      group = header[1] ?? null;
      found ||= group === "Desktop Entry";
      continue;
    }
    if (group !== "Desktop Entry") continue;
    const entry = ENTRY.exec(line);
    // The first occurrence of a key wins; later duplicates are ignored.
    if (entry?.[1] !== undefined && !keys.has(entry[1]))
      keys.set(entry[1], entry[2] ?? "");
  }
  if (!found) return null;
  const string = (key: string): string | null => {
    const value = keys.get(key);
    return value === undefined ? null : unescapeString(value);
  };
  const exec = string("Exec");
  return {
    type: string("Type"),
    name: string("Name"),
    localizedNames: [...keys.entries()].flatMap(([key, value]) =>
      key.startsWith("Name[") ? [unescapeString(value)] : [],
    ),
    genericName: string("GenericName"),
    exec: exec === null ? null : parseDesktopExec(exec),
    tryExec: string("TryExec"),
    hidden: isTrue(keys.get("Hidden")),
    noDisplay: isTrue(keys.get("NoDisplay")),
    keys,
  };
};
