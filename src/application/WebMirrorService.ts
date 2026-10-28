import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { SafeOutputTree } from "../artifacts/SafeOutputTree.js";
import { outputDirectoryAdmissionRefusal } from "../artifacts/SafeOutputTreeAdmission.js";
import {
  selectMirrorCapture,
  type SelectedMirrorCapture,
} from "../browser/assets/MirrorCapture.js";
import {
  publishWebMirror,
  type MirrorCaptureFile,
} from "../browser/assets/PublishWebMirror.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
} from "../domain/analysisErrorCore.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  browserScenarioSchema,
  type BrowserScenario,
} from "../domain/browserScenario.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { bufferedJsonParts, jsonParts } from "../domain/jsonSerialization.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  cloneWebsiteInputSchema,
  exportWebMirrorInputSchema,
  type CloneWebsiteInput,
  type ExportWebMirrorInput,
  type WebMirrorExportResult,
} from "../domain/webMirror.js";
import { webMirrorExportError } from "../domain/webScriptExportError.js";
import type { ExecutionOptions } from "./AnalysisProvider.js";
import type { BrowserScenarioCapturePort } from "./BrowserScenarioCapturePort.js";
import {
  BROWSER_SCENARIO_PROVIDER_ID,
  captureBrowserScenario,
} from "./BrowserScenarioCaptureService.js";
import { WEB_MIRROR_EXPORT_PROVIDER as PROVIDER } from "../domain/investigationProviders.js";
import {
  mapWebCaptureExportFailure,
  readSavedWebCapture,
  savedCapturePathsError,
  type WebCaptureReader,
} from "./WebCaptureRead.js";

const EXPORT_OPERATION = "export_web_mirror";
const CLONE_OPERATION = "clone_website";

const MIRROR_CAPTURE_READER: WebCaptureReader<SelectedMirrorCapture> = {
  operation: EXPORT_OPERATION,
  providerId: PROVIDER.id,
  error: webMirrorExportError(EXPORT_OPERATION),
  select: selectMirrorCapture,
};

const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Mirror one saved scenario capture through the shared CLI/MCP workflow. */
export const exportWebMirror = async (
  rawInput: unknown,
  resources: ArtifactResourceScope,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const input = exportWebMirrorInputSchema.safeParse(rawInput);
  return input.success
    ? exportWebMirrorValidated(input.data, resources, options)
    : err(
        analysisInputErrorFromIssues(
          EXPORT_OPERATION,
          input.error.issues,
          rawInput,
        ),
      );
};

/** Mirror input already parsed by a named adapter contract. */
export const exportWebMirrorValidated = async (
  input: ExportWebMirrorInput,
  resources: ArtifactResourceScope,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const invalidPaths = savedCapturePathsError(EXPORT_OPERATION, input);
  if (invalidPaths !== undefined) return err(invalidPaths);
  try {
    if (options.signal?.aborted)
      return err(
        new AnalysisCancelledError(EXPORT_OPERATION, {
          cause: options.signal.reason,
        }),
      );
    const prepared = await readSavedWebCapture(
      input.capture_path,
      MIRROR_CAPTURE_READER,
      resources,
      options.signal,
    );
    if (!prepared.ok) return prepared;
    const { bytes, loaded } = prepared.value;
    const digest = sha256(bytes);
    const result = await publishWebMirror(
      input.output_directory,
      loaded,
      { path: input.capture_path, sha256: digest },
      {
        operation: EXPORT_OPERATION,
        resources,
        error: webMirrorExportError(EXPORT_OPERATION),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    return ok(
      createEvidence(
        { path: input.capture_path, sha256: digest, format: "file" },
        PROVIDER,
        {
          predicateType: "rea.web-mirror-export",
          operation: EXPORT_OPERATION,
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
      mapWebCaptureExportFailure(cause, MIRROR_CAPTURE_READER, {
        capturePath: input.capture_path,
        outputDirectory: input.output_directory,
      }),
    );
  }
};

/** Dependencies of a live clone; the browser provider is caller-owned. */
export interface CloneWebsiteDependencies {
  readonly browser: BrowserScenarioCapturePort | undefined;
  readonly resources: ArtifactResourceScope;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

/**
 * Capture one page (and caller-listed extra pages) with retained response
 * bodies, persist the capture Evidence, and mirror it into one directory.
 */
export const cloneWebsite = async (
  rawInput: unknown,
  dependencies: CloneWebsiteDependencies,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const parsed = cloneWebsiteInputSchema.safeParse(rawInput);
  return parsed.success
    ? cloneWebsiteValidated(parsed.data, dependencies, options)
    : err(
        analysisInputErrorFromIssues(
          CLONE_OPERATION,
          parsed.error.issues,
          rawInput,
        ),
      );
};

/** Clone input already parsed by a named adapter contract. */
export const cloneWebsiteValidated = async (
  input: CloneWebsiteInput,
  dependencies: CloneWebsiteDependencies,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  if (!isAbsolute(input.output_directory))
    return err(
      inputError(
        ["output_directory"],
        "output_directory must be an absolute filesystem path on this host.",
      ),
    );
  const executable =
    input.browser_executable_path ??
    dependencies.environment.REA_BROWSER_EXECUTABLE;
  if (executable === undefined || executable === "")
    return err(
      inputError(
        ["browser_executable_path"],
        "Select a Chrome or Chromium-family executable with browser_executable_path or REA_BROWSER_EXECUTABLE. REA does not download browsers.",
      ),
    );
  const scenario = cloneScenario(input, executable);
  if (!scenario.ok) return scenario;
  // The page runs and contacts servers during capture, so refuse a
  // destination that can never be published before launching anything.
  const destination = await checkCloneDestination(input.output_directory);
  if (!destination.ok) return destination;
  if (dependencies.browser === undefined)
    return err(
      new AnalysisCapabilityUnavailableError(
        BROWSER_SCENARIO_PROVIDER_ID,
        CLONE_OPERATION,
        "browser scenario provider is not configured",
      ),
    );
  if (options.signal?.aborted)
    return err(
      new AnalysisCancelledError(CLONE_OPERATION, {
        cause: options.signal.reason,
      }),
    );
  const captured = await captureBrowserScenario(
    dependencies.browser,
    scenario.value,
    options,
  );
  if (!captured.ok) return captured;
  const evidence = captured.value;
  const error = webMirrorExportError(CLONE_OPERATION);
  let result: WebMirrorExportResult;
  try {
    result = await publishWebMirror(
      input.output_directory,
      selectMirrorCapture(evidence),
      persistedCapture(evidence),
      {
        operation: CLONE_OPERATION,
        resources: dependencies.resources,
        error,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
  } catch (cause: unknown) {
    // The completed capture stays available when its mirror is not.
    return err(
      mapWebCaptureExportFailure(
        cause,
        { operation: CLONE_OPERATION, providerId: PROVIDER.id, error },
        { capturePath: input.url, outputDirectory: input.output_directory },
      ).retainPartialObservation(evidence),
    );
  }
  return ok(
    createEvidence(undefined, PROVIDER, {
      predicateType: "rea.website-clone",
      operation: CLONE_OPERATION,
      parameters: { ...input, browser_executable_path: executable },
      result,
      rawResult: null,
      confidence: "observed",
      authority: "controlled-replay",
      subjectUnavailableReason:
        "A live website has no stable artifact identity; the persisted capture.json digest identifies the mirrored observation.",
      limitations: result.limitations,
      locations: [{ kind: "artifact-path", path: result.manifest.path }],
      evidenceLinks: [evidence.evidence_id],
    }),
  );
};

/** Read-only early admission; publication still creates the root exclusively. */
const checkCloneDestination = async (
  outputDirectory: string,
): Promise<Result<void, AnalysisError>> => {
  try {
    await SafeOutputTree.checkDestination(outputDirectory);
    return ok(undefined);
  } catch (cause: unknown) {
    const refusal = outputDirectoryAdmissionRefusal(
      CLONE_OPERATION,
      "output_directory",
      cause,
    );
    return err(
      refusal instanceof AnalysisError
        ? refusal
        : mapWebCaptureExportFailure(
            refusal,
            {
              operation: CLONE_OPERATION,
              providerId: PROVIDER.id,
              error: webMirrorExportError(CLONE_OPERATION),
            },
            { capturePath: "", outputDirectory },
          ),
    );
  }
};

/**
 * The capture Evidence as capture.json. Retained bodies can exceed the
 * longest string V8 allows, so the JSON is digested and later written in
 * bounded parts; both passes serialize the same value identically.
 */
const persistedCapture = (evidence: Evidence): MirrorCaptureFile => {
  const parts = (): Iterable<string> => bufferedJsonParts(jsonParts(evidence));
  const hash = createHash("sha256");
  let bytes = 0;
  for (const part of parts()) {
    const chunk = Buffer.from(part, "utf8");
    hash.update(chunk);
    bytes += chunk.byteLength;
  }
  return {
    path: "capture.json",
    sha256: hash.digest("hex"),
    persist: { bytes, parts },
  };
};

const inputError = (
  path: readonly string[],
  message: string,
): AnalysisInputError =>
  new AnalysisInputError(CLONE_OPERATION, undefined, [
    { path: [...path], reason: "invalid_value", message },
  ]);

/**
 * Translate clone choices into one bounded scenario. Body budgets use the
 * capture's own allocation estimate (base64 text charged per character), so
 * the selected byte limits are what can actually be retained.
 */
const cloneScenario = (
  input: CloneWebsiteInput,
  executable: string,
): Result<BrowserScenario, AnalysisError> => {
  const allocation = (bytes: number): number => Math.ceil(bytes / 3) * 32 + 2;
  const metadataMargin = 64 * 1024 * 1024;
  const settle = Math.max(1, input.settle_ms);
  const parsed = browserScenarioSchema.safeParse({
    browser: {
      mode: "launch",
      executable_path: executable,
      headless: input.headless,
    },
    start_url: { url: input.url },
    actions: [
      { step_id: "settle-0", action: "wait_for_timeout", duration_ms: settle },
      ...input.additional_urls.flatMap((url, index) => [
        {
          step_id: `page-${index + 1}`,
          action: "goto",
          destination: { url },
          wait_until: "load",
        },
        {
          step_id: `settle-${index + 1}`,
          action: "wait_for_timeout",
          duration_ms: settle,
        },
      ]),
    ],
    capture: {
      network: {
        request_body: false,
        response_body: true,
        header_values: false,
      },
      limits: {
        max_events: input.max_resources * 6 + 1_000,
        max_event_allocation_bytes:
          allocation(input.max_resource_bytes) + metadataMargin,
        max_total_event_allocation_bytes:
          allocation(input.max_total_bytes) + metadataMargin,
        max_network_transactions: input.max_resources,
        max_network_body_bytes: input.max_resource_bytes,
        max_network_body_allocation_bytes: allocation(input.max_resource_bytes),
        max_network_header_allocation_bytes: metadataMargin,
        max_network_metadata_allocation_bytes: metadataMargin,
      },
    },
  });
  if (parsed.success) return ok(parsed.data);
  return err(
    new AnalysisInputError(
      CLONE_OPERATION,
      { cause: parsed.error },
      parsed.error.issues.map((issue) => ({
        path: cloneIssuePath(issue.path),
        reason: "invalid_value",
        message: issue.message,
      })),
    ),
  );
};

// Report scenario validation against the clone fields that produced it.
const cloneIssuePath = (path: readonly PropertyKey[]): string[] => {
  const [section, index, field] = path;
  if (section === "start_url") return ["url"];
  if (section === "browser") return ["browser_executable_path"];
  if (
    section === "actions" &&
    typeof index === "number" &&
    field === "destination"
  )
    return ["additional_urls", String((index - 1) / 2)];
  return path.map(String);
};
