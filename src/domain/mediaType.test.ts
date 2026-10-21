import { describe, expect, it } from "vitest";

import {
  isJsonMediaType,
  mediaTypeEssence,
  parseMediaType,
} from "./mediaType.js";

describe("parseMediaType", () => {
  it("lowercases the essence and parameter names but keeps values", () => {
    const parsed = parseMediaType('Text/HTML; Charset="UTF-8"; q=1');
    expect(parsed?.essence).toBe("text/html");
    expect([...(parsed?.parameters ?? [])]).toEqual([
      ["charset", "UTF-8"],
      ["q", "1"],
    ]);
  });

  it("reads quoted values with escapes and keeps the first repeated name", () => {
    const parsed = parseMediaType('text/plain;charset="ut\\"f";charset=latin1');
    expect(parsed?.parameters.get("charset")).toBe('ut"f');
  });

  it("skips malformed parameters and rejects invalid essences", () => {
    expect([
      ...(parseMediaType("text/css; bad; =x; ok=yes")?.parameters ?? []),
    ]).toEqual([["ok", "yes"]]);
    expect(parseMediaType("text")).toBeNull();
    expect(parseMediaType("text /css")).toBeNull();
    expect(mediaTypeEssence(" \tapplication/JSON ; x=1")).toBe(
      "application/json",
    );
  });

  it("recognizes JSON and +json structured suffixes only", () => {
    expect(isJsonMediaType("application/json; charset=utf-8")).toBe(true);
    expect(isJsonMediaType("application/problem+json")).toBe(true);
    expect(isJsonMediaType("text/json-ish")).toBe(false);
    expect(isJsonMediaType(null)).toBe(false);
    expect(isJsonMediaType("not a type")).toBe(false);
  });
});
