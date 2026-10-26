import { createHash } from "node:crypto";

/** Lowercase hexadecimal SHA-256 of UTF-8 text. */
export const sha256Text = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

const PORTABLE_SEGMENT = /^[A-Za-z0-9_~.-]+$/u;
// The smallest common name limit: eCryptfs-encrypted names hold 143 bytes,
// while ext4, APFS and NTFS hold 255. Portable segments are ASCII.
const MAX_PORTABLE_SEGMENT_LENGTH = 143;
const RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

/**
 * One path segment every supported destination filesystem stores verbatim:
 * portable characters only, a name every common filesystem can hold, no dot
 * segments, no trailing dot and no Windows device name.
 */
export const isPortablePathSegment = (segment: string): boolean =>
  segment.length <= MAX_PORTABLE_SEGMENT_LENGTH &&
  PORTABLE_SEGMENT.test(segment) &&
  segment !== "." &&
  segment !== ".." &&
  !segment.endsWith(".") &&
  !RESERVED_SEGMENT.test(segment);

/**
 * Indices whose planned relative paths collide. Every exact prefix is
 * registered so a repeated path, or a file that is also a directory prefix,
 * isolates every affected entry. Case-distinct spellings stay distinct until
 * the destination filesystem reports a collision.
 */
export const conflictingPaths = (
  paths: readonly (string | undefined)[],
): Set<number> => {
  const prefixes = new Map<string, { indices: number[]; files: number[] }>();
  paths.forEach((path, index) => {
    if (path === undefined) return;
    const parts = path.split("/");
    parts.forEach((_, position) => {
      const spelling = parts.slice(0, position + 1).join("/");
      const entry = prefixes.get(spelling) ?? { indices: [], files: [] };
      entry.indices.push(index);
      if (position === parts.length - 1) entry.files.push(index);
      prefixes.set(spelling, entry);
    });
  });
  const conflicts = new Set<number>();
  for (const entry of prefixes.values())
    if (
      entry.files.length > 1 ||
      (entry.files.length > 0 && entry.indices.length > entry.files.length)
    )
      for (const index of entry.indices) conflicts.add(index);
  return conflicts;
};
