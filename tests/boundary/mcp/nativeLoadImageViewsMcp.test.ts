import { expect, it } from "vitest";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisView.js";
import {
  nativeDolLoadImageFixture,
  nativeRawLoadImageFixture,
} from "../../fixtures/nativeLoadImage.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";

it("preserves raw and DOL verification facts and selected DOL sections through the advertised SDK output", async () => {
  const { call } = await connectLocalToolsMcp();
  for (const report of [
    nativeRawLoadImageFixture(),
    nativeDolLoadImageFixture(),
  ]) {
    const parent = createEvidence(
      {
        path: "/selected/fixture",
        sha256: report.target_sha256,
        format: report.format,
        architecture: report.architecture,
      },
      { id: "ghidra", name: "Ghidra", version: "12.1.4" },
      {
        operation: "inspect_native_load_image",
        parameters: {},
        result: report,
      },
    );
    const source = { kind: "inline", evidence: parent };
    const summary = await call("inspect_analysis_view", {
      source,
      view: { kind: "summary" },
    });
    expect(summary.isError, JSON.stringify(summary.content)).not.toBe(true);
    const result = analysisViewResultSchema.parse(
      parseEvidence(summary.structuredContent).normalized_result,
    );
    const {
      observations: _observations,
      checks,
      limitations: _limitations,
      ...verification
    } = report;
    if ("sections" in verification)
      Reflect.deleteProperty(verification, "sections");
    expect(result).toMatchObject({
      summary: {
        verification,
        counts: {
          checks: checks.length,
          sections: report.format === "gamecube-dol" ? 2 : null,
        },
      },
    });
    if (report.format !== "gamecube-dol") continue;
    const page = await call("inspect_analysis_view", {
      source,
      view: {
        kind: "native-load-image",
        collection: "sections",
        indices: [1, 0, 1],
        offset: 1,
        limit: 1,
        fields: ["kind", "address"],
      },
    });
    expect(page.isError, JSON.stringify(page.content)).not.toBe(true);
    const section = analysisViewResultSchema.parse(
      parseEvidence(page.structuredContent).normalized_result,
    );
    if (section.kind !== "native-load-image") throw new Error("Expected page");
    expect(section.items.rows).toEqual([
      {
        source_index: 1,
        record: { kind: "data", address: "ram:0x80004000" },
      },
    ]);
    expect(section).toMatchObject({
      verification_status: "mismatch",
      parent_evidence_id: parent.evidence_id,
      items: {
        collection: "sections",
        rows: [
          {
            source_index: 1,
            record: { kind: "data", address: "ram:0x80004000" },
          },
        ],
      },
      coverage: { total: 2, next_offset: null, exhausted: true },
      limitations: expect.arrayContaining(report.limitations),
    });
  }
}, 30_000);
