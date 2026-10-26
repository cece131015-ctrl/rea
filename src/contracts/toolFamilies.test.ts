import { describe, expect, it } from "vitest";

import {
  TOOL_FAMILY_DEFINITIONS,
  TOOL_FAMILY_IDS,
  contractsForToolFamilies,
  toolFamilyId,
} from "./toolFamilies.js";
import { TOOL_CONTRACTS } from "./toolContracts.js";

describe("tool families", () => {
  it("declares exactly one definition per published id", () => {
    expect(TOOL_FAMILY_DEFINITIONS.map(({ id }) => id)).toEqual([
      ...TOOL_FAMILY_IDS,
    ]);
  });

  it("covers every contract exactly once", () => {
    const owners = new Map<string, string[]>();
    for (const { id, contracts } of TOOL_FAMILY_DEFINITIONS)
      for (const { name } of contracts)
        owners.set(name, [...(owners.get(name) ?? []), id]);
    expect([...owners].filter(([, ids]) => ids.length > 1)).toEqual([]);
    expect([...owners.keys()].sort()).toEqual(
      TOOL_CONTRACTS.map(({ name }) => name).sort(),
    );
  });

  it("resolves each advertised tool to its owning family", () => {
    for (const { name } of TOOL_CONTRACTS)
      expect(TOOL_FAMILY_IDS).toContain(toolFamilyId(name));
    expect(toolFamilyId("not_a_tool")).toBeUndefined();
  });

  it("projects catalog contracts from a family selection", () => {
    expect(contractsForToolFamilies(undefined)).toEqual(TOOL_CONTRACTS);
    expect(contractsForToolFamilies(new Set())).toEqual([]);
    const scoped = contractsForToolFamilies(new Set(["session"]));
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.length).toBeLessThan(TOOL_CONTRACTS.length);
    expect(scoped.map(({ name }) => name)).toEqual(
      TOOL_CONTRACTS.filter(({ name }) => toolFamilyId(name) === "session").map(
        ({ name }) => name,
      ),
    );
  });
});
