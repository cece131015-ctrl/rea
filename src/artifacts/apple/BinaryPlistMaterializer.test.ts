import { expect, it } from "vitest";
import { binaryPlistObjectTable } from "../../../tests/fixtures/binaryPlistObjectTable.js";
import { plistUidValue } from "../../domain/apple/plistUid.js";
import { decodeBinaryPlistValue } from "./BinaryPlistMaterializer.js";
import { estimateBinaryPlistExpansion } from "./PropertyListDecodeBudget.js";

const source = (objects: readonly Buffer[]): Buffer => {
  const table =
    8 + objects.reduce((length, object) => length + object.length, 0);
  const bytes = Buffer.alloc(table + objects.length + 32);
  let cursor = 8;
  const offsets = objects.map((object) => {
    const offset = cursor;
    object.copy(bytes, cursor);
    cursor += object.length;
    return offset;
  });
  return binaryPlistObjectTable(bytes, offsets, table);
};
const text = (value: string): Buffer =>
  Buffer.concat([Buffer.from([0x50 | value.length]), Buffer.from(value)]);
const decode = (bytes: Buffer) =>
  decodeBinaryPlistValue(
    bytes,
    estimateBinaryPlistExpansion(bytes, 1024 * 1024, {
      uidProjection: true,
      numberProjection: true,
    }),
  );

it("materializes own dictionary keys and keeps the last duplicate's source UID", () => {
  const bytes = source([
    Buffer.from([0xd3, 1, 2, 1, 3, 4, 5]),
    text("__proto__"),
    text("constructor"),
    Buffer.from([0x80, 1]),
    text("kept"),
    Buffer.from([0x80, 2]),
  ]);
  const value = decode(bytes) as Record<string, unknown>;
  expect(Object.keys(value)).toEqual(["__proto__", "constructor"]);
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  expect(plistUidValue(value["__proto__"])).toBe(2);
  expect(value.constructor).toBe("kept");
});

it("expands shared containers and nonprimitive scalar references independently", () => {
  const date = Buffer.alloc(9);
  date[0] = 0x33;
  date.writeDoubleBE(1, 1);
  const bytes = source([
    Buffer.from([0xa8, 1, 1, 2, 2, 3, 3, 4, 4]),
    Buffer.from([0xd1, 5, 6]),
    date,
    Buffer.from([0x42, 1, 2]),
    Buffer.from([0x80, 7]),
    text("nested"),
    text("kept"),
  ]);
  const value = decode(bytes) as unknown[];
  for (let index = 0; index < value.length; index += 2) {
    expect(value[index]).toEqual(value[index + 1]);
    expect(value[index]).not.toBe(value[index + 1]);
  }
  expect(plistUidValue(value[6])).toBe(7);
  expect(plistUidValue(value[7])).toBe(7);
});

it("keeps a source UID distinct from an ordinary UID-shaped dictionary", () => {
  const bytes = source([
    Buffer.from([0xa2, 1, 2]),
    Buffer.from([0x80, 7]),
    Buffer.from([0xd1, 3, 4]),
    text("UID"),
    Buffer.from([0x10, 7]),
  ]);
  const value = decode(bytes) as unknown[];
  expect(value[0]).toEqual({ UID: 7 });
  expect(value[1]).toEqual({ UID: 7 });
  expect(plistUidValue(value[0])).toBe(7);
  expect(plistUidValue(value[1])).toBeUndefined();
});
