import { BinaryFormatFailure } from "./BinaryContainer.js";

export const readElfString = (bytes: Buffer, offset: number): string => {
  return readElfStringBytes(bytes, offset).toString("latin1");
};

/** Read exact string-table bytes; ELF does not prescribe a character encoding. */
export const readElfStringBytes = (bytes: Buffer, offset: number): Buffer => {
  if (offset >= bytes.length)
    throw new BinaryFormatFailure(
      "malformed",
      "ELF string offset is outside its string table",
    );
  const end = bytes
    .subarray(offset, Math.min(bytes.length, offset + 65536))
    .indexOf(0);
  if (end < 0)
    throw new BinaryFormatFailure(
      "malformed",
      "ELF string is unterminated or exceeds the string budget",
    );
  return bytes.subarray(offset, offset + end);
};
