import { ArtifactOperationError } from "./artifactOperationError.js";
import type { AnalysisErrorOptions } from "./analysisErrorBase.js";

/** Public operations that publish files from a saved or live web capture. */
export type WebCaptureExportOperation =
  | "export_web_scripts"
  | "export_web_mirror"
  | "clone_website";

/** Options shared by web capture publication failures. */
export type WebCaptureExportErrorOptions = AnalysisErrorOptions & {
  readonly residualPaths?: readonly string[];
};

/** Publication failure retaining its input/output target and cleanup state. */
export class WebCaptureExportError extends ArtifactOperationError {
  override readonly userMessage: string;
  override cleanupIncomplete: boolean;

  constructor(
    operation: WebCaptureExportOperation,
    label: string,
    reason: ArtifactOperationError["reason"],
    target: string,
    diagnostic: string,
    options: WebCaptureExportErrorOptions = {},
  ) {
    super(operation, reason, undefined, undefined, options);
    this.userMessage = `${label} failed for ${target}: ${diagnostic}`;
    this.setCleanupResources([
      ...new Set([
        ...(options.cleanup?.resources ?? []),
        ...(options.residualPaths ?? []),
      ]),
    ]);
    this.cleanupIncomplete =
      options.cleanup !== undefined || (options.residualPaths?.length ?? 0) > 0;
  }
}

/** Script export failure; keeps its established operation and wording. */
export class WebScriptExportError extends WebCaptureExportError {
  constructor(
    reason: ArtifactOperationError["reason"],
    target: string,
    diagnostic: string,
    options: WebCaptureExportErrorOptions = {},
  ) {
    super(
      "export_web_scripts",
      "Script export",
      reason,
      target,
      diagnostic,
      options,
    );
  }
}

/** Factory for one operation's publication failures. */
export type WebCaptureExportErrorFactory = (
  reason: ArtifactOperationError["reason"],
  target: string,
  diagnostic: string,
  options?: WebCaptureExportErrorOptions,
) => WebCaptureExportError;

/** Website mirror export or clone failure. */
export const webMirrorExportError =
  (
    operation: "export_web_mirror" | "clone_website",
  ): WebCaptureExportErrorFactory =>
  (reason, target, diagnostic, options) =>
    new WebCaptureExportError(
      operation,
      operation === "clone_website" ? "Website clone" : "Website mirror export",
      reason,
      target,
      diagnostic,
      options,
    );
