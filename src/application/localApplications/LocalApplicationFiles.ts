import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";

import type { LocalApplication } from "../../domain/localApplications.js";

/** Host facts discovery depends on; injectable so every platform is testable. */
export interface LocalApplicationHost {
  readonly platform: NodeJS.Platform;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
}

/** An application candidate before name matching. */
export type Candidate = Omit<LocalApplication, "matched_field" | "exact"> & {
  /** Searchable names by field, in priority order. */
  readonly names: readonly (readonly [field: string, value: string])[];
  /** A desktop entry marked Hidden or NoDisplay; ranks after visible ones. */
  readonly hidden?: boolean;
};

export const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

/** Read a small metadata file, or undefined when it exceeds the bound. */
export const readBounded = async (
  path: string,
  limit: number,
): Promise<Buffer | undefined> => {
  const handle = await open(path, constants.O_RDONLY);
  try {
    const { size } = await handle.stat();
    if (size > limit) return undefined;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
};

const ASAR_LOCATIONS = [
  ["Contents", "Resources", "app.asar"],
  ["resources", "app.asar"],
];

/** Electron archives at the conventional bundle and install locations. */
export const electronArchives = async (root: string): Promise<string[]> => {
  const found: string[] = [];
  for (const parts of ASAR_LOCATIONS) {
    const path = join(root, ...parts);
    try {
      if ((await stat(path)).isFile()) found.push(path);
    } catch {
      // Absent archives are the common case.
    }
  }
  return found;
};
