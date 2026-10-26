import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { publishWebScripts } from "../browser/assets/PublishWebScripts.js";
import { selectScriptCapture } from "../browser/assets/ScriptCaptureAdapters.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  exportWebScriptsInputSchema,
  type ExportWebScriptsInput,
} from "../domain/webScriptExport.js";
import { WebScriptExportError } from "../domain/webScriptExportError.js";
import type { ExecutionOptions } from "./AnalysisProvider.js";
import { WEB_SCRIPT_EXPORT_PROVIDER as PROVIDER } from "../domain/investigationProviders.js";
import {
  mapWebCaptureExportFailure,
  readSavedWebCapture,
  type WebCaptureReader,
} from "./WebCaptureRead.js";

const OPERATION = "export_web_scripts";

const SCRIPT_CAPTURE_READER: WebCaptureReader<
  ReturnType<typeof selectScriptCapture>
> = {
  operation: OPERATION,
  providerId: PROVIDER.id,
  error: (reason, target, diagnostic, options) =>
    new WebScriptExportError(reason, target, diagnostic, options),
  select: (json) => selectScriptCapture(json),
};

/** Export one local capture through the shared CLI/MCP application workflow. */
export const exportWebScripts = async (
  rawInput: unknown,
  resources: ArtifactResourceScope,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const input = exportWebScriptsInputSchema.safeParse(rawInput);
  return input.success
    ? exportWebScriptsValidated(input.data, resources, options)
    : err(
        analysisInputErrorFromIssues(OPERATION, input.error.issues, rawInput),
      );
};

/** Publish input already parsed by a named adapter contract. */
export const exportWebScriptsValidated = async (
  input: ExportWebScriptsInput,
  resources: ArtifactResourceScope,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  if (!isAbsolute(input.capture_path) || !isAbsolute(input.output_directory))
    return err(
      new AnalysisInputError(OPERATION, undefined, [
        {
          path: [],
          reason: "invalid_format",
          message:
            "capture_path and output_directory must be absolute filesystem paths on this host.",
        },
      ]),
    );
  try {
    if (options.signal?.aborted)
      return err(
        new AnalysisCancelledError(OPERATION, { cause: options.signal.reason }),
      );
    const prepared = await readSavedWebCapture(
      input.capture_path,
      SCRIPT_CAPTURE_READER,
      resources,
      options.signal,
    );
    if (!prepared.ok) return prepared;
    const { bytes, loaded } = prepared.value;
    if (options.signal?.aborted)
      return err(
        new AnalysisCancelledError(OPERATION, { cause: options.signal.reason }),
      );
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const result = await publishWebScripts(input, loaded, sha256, {
      resources,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (options.signal?.aborted === true)
      return err(
        new AnalysisCancelledError(OPERATION, {
          cause: options.signal.reason,
          partialObservation: { kind: "web-script-export", result },
        }),
      );
    return ok(
      createEvidence(
        { path: input.capture_path, sha256, format: "file" },
        PROVIDER,
        {
          predicateType: "rea.web-script-export",
          operation: OPERATION,
          parameters: {
            capture_path: input.capture_path,
            output_directory: input.output_directory,
          },
          result,
          rawResult: null,
          confidence: "derived",
          authority: "historical-reference",
          limitations: result.limitations,
          locations: [{ kind: "artifact-path", path: result.manifest.path }],
          evidenceLinks:
            loaded.sourceEvidenceId === null ? [] : [loaded.sourceEvidenceId],
        },
      ),
    );
  } catch (cause: unknown) {
    return err(
      mapWebCaptureExportFailure(cause, SCRIPT_CAPTURE_READER, {
        capturePath: input.capture_path,
        outputDirectory: input.output_directory,
      }),
    );
  }
};
