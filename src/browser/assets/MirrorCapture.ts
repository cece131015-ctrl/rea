import {
  browserScenarioCaptureSchema,
  type BrowserScenarioCapture,
} from "../../domain/browserScenarioCapture.js";
import { parseEvidence } from "../../domain/evidence.js";
import type { CapturedWebResource } from "../../domain/webMirror.js";
import { scenarioResponses } from "./ScenarioResponseCapture.js";

/** A validated scenario capture projected for mirroring. */
export interface SelectedMirrorCapture {
  readonly completeness: BrowserScenarioCapture["completeness"];
  readonly resources: readonly CapturedWebResource[];
  /** The final URL of the start navigation, which selects the entry document. */
  readonly entryUrl: string;
  /** Event sequences of the start navigation step, inclusive. */
  readonly entrySequences: { readonly first: number; readonly last: number };
  readonly limitations: readonly string[];
  readonly sourceEvidenceId: string | null;
}

const SCENARIO_OPERATION = "capture_browser_scenario";

const select = (
  capture: BrowserScenarioCapture,
  sourceEvidenceId: string | null,
): SelectedMirrorCapture => ({
  completeness: capture.completeness,
  resources: scenarioResponses(capture),
  entryUrl: capture.steps[0]?.after_url.url ?? "",
  entrySequences: {
    first: capture.steps[0]?.event_sequence_start ?? 0,
    last: capture.steps[0]?.event_sequence_end ?? -1,
  },
  limitations: capture.limitations,
  sourceEvidenceId,
});

/**
 * Accept a capture_browser_scenario normalized result or Evidence envelope.
 * Passive page inspections retain no non-script bytes and are rejected.
 */
export const selectMirrorCapture = (raw: unknown): SelectedMirrorCapture => {
  if (
    typeof raw === "object" &&
    raw !== null &&
    ("normalized_result" in raw || "evidence_id" in raw)
  ) {
    const evidence = parseEvidence(raw);
    if (evidence.operation === SCENARIO_OPERATION) {
      const parsed = browserScenarioCaptureSchema.safeParse(
        evidence.normalized_result,
      );
      if (parsed.success) return select(parsed.data, evidence.evidence_id);
    }
  } else {
    const parsed = browserScenarioCaptureSchema.safeParse(raw);
    if (parsed.success) return select(parsed.data, null);
  }
  throw new TypeError(
    "Expected a valid capture_browser_scenario capture. Website mirrors need retained response bytes (capture.network.response_body); inspect_web_page captures keep no non-script bytes. Evidence envelopes must have a matching operation and semantic identifier.",
  );
};
