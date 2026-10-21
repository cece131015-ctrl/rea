import type { BrowserScenarioCapture } from "../../domain/browserScenarioCapture.js";
import type { BrowserScenarioEvent } from "../../domain/browserScenarioCaptureValues.js";
import type { BrowserNetworkBody } from "../../domain/browserNetworkEvidence.js";
import type {
  CapturedWebResource,
  CapturedWebResourceBody,
} from "../../domain/webMirror.js";

type RequestEvent = Extract<BrowserScenarioEvent, { kind: "request" }>;
type ResponseEvent = Extract<BrowserScenarioEvent, { kind: "response" }>;
type ContentEvent = Extract<BrowserScenarioEvent, { kind: "network-content" }>;

interface ResponseIndex {
  readonly responses: Map<string, ResponseEvent[]>;
  readonly contents: Map<number, ContentEvent[]>;
  readonly requests: Map<string, number>;
}

/**
 * Join every request to its response bytes only through explicit
 * transaction and event identity; URLs never select bytes.
 */
export const scenarioResponses = (
  capture: BrowserScenarioCapture,
): CapturedWebResource[] => {
  const index = indexResponses(capture.events.items);
  return capture.events.items.flatMap((request) =>
    request.kind === "request" ? [projectRequest(request, index)] : [],
  );
};

/** Decode retained bytes at the point of use so callers hold one copy. */
export const responseBodyBytes = (body: CapturedWebResourceBody): Buffer =>
  Buffer.from(body.base64, "base64");

const indexResponses = (
  events: readonly BrowserScenarioEvent[],
): ResponseIndex => {
  const index: ResponseIndex = {
    responses: new Map(),
    contents: new Map(),
    requests: new Map(),
  };
  for (const event of events) {
    if (event.kind === "request")
      index.requests.set(
        event.transaction_id,
        (index.requests.get(event.transaction_id) ?? 0) + 1,
      );
    if (event.kind === "response")
      append(index.responses, event.transaction_id, event);
    if (event.kind === "network-content" && event.phase === "response")
      append(index.contents, event.source_event_sequence, event);
  }
  return index;
};

const projectRequest = (
  request: RequestEvent,
  index: ResponseIndex,
): CapturedWebResource => {
  const id = request.transaction_id;
  const matches = index.responses.get(id) ?? [];
  const response = matches.length === 1 ? matches[0] : undefined;
  const bodies =
    response === undefined ? [] : (index.contents.get(response.sequence) ?? []);
  const body = bodies.length === 1 ? bodies[0]?.body : undefined;
  const ambiguous =
    index.requests.get(id) !== 1 || matches.length > 1 || bodies.length > 1;
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
    content: projectBody(body, ambiguous),
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
): CapturedWebResource["content"] => {
  if (ambiguous)
    return unavailable(
      "ambiguous-transaction",
      "The capture does not identify one request, response, and content record for this transaction.",
    );
  if (body === undefined)
    return unavailable(
      "response-content-not-retained",
      "No selected, completed response bytes were retained for this request.",
    );
  if (body.state === "unavailable")
    return unavailable(body.reason, body.message);
  if (body.state !== "captured")
    return unavailable(
      body.state,
      "No selected, completed response bytes were retained for this request.",
    );
  if (
    body.representation !== "playwright-response-body-bytes" &&
    body.representation !== "browser-decoded-response-bytes"
  )
    return unavailable(
      "unsupported-body-representation",
      `Captured representation ${body.representation} is not response body bytes.`,
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

const append = <Key, Value>(
  map: Map<Key, Value[]>,
  key: Key,
  value: Value,
): void => {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [value]);
  else existing.push(value);
};
