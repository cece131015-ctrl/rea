/** Bounded source observation; consumers own scan limits, charging and caching. */
export type ElfSectionNameObservation =
  | {
      readonly state: "outside";
      readonly bytes: null;
      readonly examinedBytes: 0;
      readonly contentBytes: 0;
    }
  | {
      readonly state: "terminated";
      readonly bytes: Buffer;
      readonly examinedBytes: number;
      readonly contentBytes: number;
    }
  | {
      readonly state: "truncated";
      readonly bytes: null;
      readonly examinedBytes: number;
      readonly contentBytes: number;
    };

/** Observe an ELF string-table name without treating a bounded missing NUL as absence. */
export const observeElfSectionName = (
  table: Buffer,
  offset: number,
  maximumBytes: number,
): ElfSectionNameObservation => {
  if (offset < 0 || offset >= table.length)
    return { state: "outside", bytes: null, examinedBytes: 0, contentBytes: 0 };
  const window = table.subarray(offset, offset + maximumBytes);
  const end = window.indexOf(0);
  if (end < 0)
    return {
      state: "truncated",
      bytes: null,
      examinedBytes: window.length,
      contentBytes: window.length,
    };
  return {
    state: "terminated",
    bytes: window.subarray(0, end),
    examinedBytes: end + 1,
    contentBytes: end,
  };
};

/** Project admitted source bytes without inferring an original text encoding. */
export const elfSectionNameText = (
  observed: ElfSectionNameObservation,
): string | null => observed.bytes?.toString("latin1") ?? null;
