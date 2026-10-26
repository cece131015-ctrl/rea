import { expect, it } from "vitest";
import {
  readMachoHeaderDeclarations,
  readMachoLoadCommandDeclarations,
  readMachoLoadCommandTableHeader,
} from "./machoLoadCommands.js";

it.each([
  { magic: 0xfeedface, wide: false, littleEndian: false },
  { magic: 0xcefaedfe, wide: false, littleEndian: true },
  { magic: 0xfeedfacf, wide: true, littleEndian: false },
  { magic: 0xcffaedfe, wide: true, littleEndian: true },
])(
  "separates common header observations from full header and table admission ($magic)",
  ({ magic, wide, littleEndian }) => {
    const backing = Buffer.alloc(43, 0xa5);
    const bytes = backing.subarray(7, 35);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(0, magic, false);
    view.setUint32(4, 0xfedcba98, littleEndian);
    view.setUint32(8, 0x89abcdef, littleEndian);
    view.setUint32(12, 0xffffffff, littleEndian);
    view.setUint32(16, 0x80000001, littleEndian);
    view.setUint32(20, 0xffffffff, littleEndian);
    const expected = {
      headerSize: wide ? 32 : 28,
      wide,
      littleEndian,
      commandCount: 0x80000001,
      commandBytes: 0xffffffff,
      fileType: 0xffffffff,
      identity: { cpuType: 0xfedcba98, cpuSubtype: 0x89abcdef },
    };
    expect(readMachoHeaderDeclarations(bytes, 32)).toEqual({
      ok: true,
      value: expected,
    });
    expect(readMachoLoadCommandDeclarations(bytes, 32)).toEqual(
      wide
        ? {
            ok: false,
            error:
              "truncated Mach-O header: a 64-bit header needs 32 bytes; the file has 32",
          }
        : { ok: true, value: expected },
    );
    const complete = backing.subarray(7, wide ? 39 : 35);
    expect(readMachoLoadCommandDeclarations(complete, 32)).toEqual({
      ok: true,
      value: expected,
    });
    expect(readMachoLoadCommandTableHeader(complete, 32)).toMatchObject({
      ok: false,
    });
    expect(
      readMachoHeaderDeclarations(bytes.subarray(0, 27), 32),
    ).toMatchObject({ ok: false });
  },
);
