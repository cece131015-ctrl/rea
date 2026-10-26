import type { BrowserScenarioCapture } from "../../domain/browserScenarioCapture.js";
import type { CapturedWebScript } from "../../domain/webScriptExport.js";
import {
  responseBodyBytes,
  scenarioResponses,
} from "./ScenarioResponseCapture.js";

/** Join script response bytes only through explicit transaction and event identity. */
export const scenarioScripts = (
  capture: Pick<BrowserScenarioCapture, "events">,
): CapturedWebScript[] =>
  scenarioResponses(capture, {
    resourceType: "script",
    bytesLabel: "script response bytes",
  }).map(({ source, url, content }): CapturedWebScript => ({
    source,
    url,
    content:
      content.state === "captured"
        ? {
            state: "captured",
            bytes: responseBodyBytes(content),
            sha256: content.sha256,
            media_type: content.media_type,
            redacted: content.redacted,
            representation: content.representation,
          }
        : content,
  }));
