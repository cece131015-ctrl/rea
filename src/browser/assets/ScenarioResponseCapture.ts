import type { BrowserScenarioCapture } from "../../domain/browserScenarioCapture.js";
import type { BrowserScenarioEvent } from "../../domain/browserScenarioCaptureValues.js";
import type { BrowserNetworkBody } from "../../domain/browserNetworkEvidence.js";
import {
  indexBrowserScenarioTransactions,
  type BrowserScenarioTransactionIndex,
} from "../../domain/browserScenarioTransactions.js";
import type {
  CapturedWebResource,
  CapturedWebResourceBody,
} from "../../domain/webMirror.js";

type RequestEvent = Extract<BrowserScenarioEvent, { kind: "request" }>;

/** Which requests a projection keeps, and how its messages name their bytes. */
export interface ScenarioResponseSelection {
  /** Keep only requests of this resource type; every request when omitted. */
  readonly resourceType?: string;
  /** The retained bytes, as unavailable-content messages name them. */
  readonly bytesLabel: string;
}

const ALL_RESPONSES: ScenarioResponseSelection = {
  bytesLabel: "response bytes",
};

/**
 * Join every selected request to its response bytes only through explicit
 * transaction and event identity; URLs never select bytes.
 */
export const scenarioResponses = (
  capture: Pick<BrowserScenarioCapture, "events">,
  selection: ScenarioResponseSelection = ALL_RESPONSES,
): CapturedWebResource[] => {
  const index = indexBrowserScenarioTransactions(capture.events.items);
  return capture.events.items.flatMap((request) =>
    request.kind === "request" &&
    (selection.resourceType === undefined ||
      request.resource_type === selection.resourceType)
      ? [projectRequest(request, index, selection.bytesLabel)]
      : [],
  );
};

/** Decode retained bytes at the point of use so callers hold one copy. */
export const responseBodyBytes = (body: CapturedWebResourceBody): Buffer =>
  Buffer.from(body.base64, "base64");

const projectRequest = (
  request: RequestEvent,
  index: BrowserScenarioTransactionIndex,
  bytesLabel: string,
): CapturedWebResource => {
  const id = request.transaction_id;
  const matches = index.responses.get(id) ?? [];
  const response = matches.length === 1 ? matches[0] : undefined;
  const bodies =
    response === undefined
      ? []
      : (index.contents.get(response.sequence) ?? []).filter(
          ({ phase }) => phase === "response",
        );
  const body = bodies.length === 1 ? bodies[0]?.body : undefined;
  const ambiguous =
    index.requestCounts.get(id) !== 1 ||
    matches.length > 1 ||
    bodies.length > 1;
  return {
    source: {
      kind: "scenario-response",
      transaction_id: id,
      request_sequence: request.sequence,
      response_sequence: ambiguous ? null : (response?.sequence ?? null),
      status: ambiguous ? null : (response?.status ?? null),
    },
    method: request.method,
    url: request.url.url,
    resource_type: request.resource_type,
    redirected_from_transaction_id: request.redirected_from_transaction_id,
    content: projectBody(body, ambiguous, bytesLabel),
  };
};

const unavailable = (
  reason: string,
  message: string,
): CapturedWebResource["content"] => ({
  state: "unavailable",
  reason,
  message,
});

const projectBody = (
  body: BrowserNetworkBody | undefined,
  ambiguous: boolean,
  bytesLabel: string,
): CapturedWebResource["content"] => {
  if (ambiguous)
    return unavailable(
      "ambiguous-transaction",
      "The capture does not identify one request, response, and content record for this transaction.",
    );
  const notRetained = `No selected, completed ${bytesLabel} were retained for this request.`;
  if (body === undefined)
    return unavailable("response-content-not-retained", notRetained);
  if (body.state === "unavailable")
    return unavailable(body.reason, body.message);
  if (body.state !== "captured") return unavailable(body.state, notRetained);
  if (
    body.representation !== "playwright-response-body-bytes" &&
    body.representation !== "browser-decoded-response-bytes"
  )
    return unavailable(
      "unsupported-body-representation",
      `Captured representation ${body.representation} is not ${bytesLabel}.`,
    );
  return {
    state: "captured",
    base64: body.content,
    bytes: body.bytes,
    sha256: body.sha256,
    media_type: body.media_type,
    redacted: body.redacted,
    representation: body.representation,
  };
};
