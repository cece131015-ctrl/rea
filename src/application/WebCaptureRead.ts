import { z } from "zod";

import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  AnalysisAccessDeniedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import { safeParseJson } from "../domain/safeJson.js";
import {
  WebCaptureExportError,
  type WebCaptureExportErrorFactory,
  type WebCaptureExportOperation,
} from "../domain/webScriptExportError.js";
import {
  readRegularFile,
  RegularFileCleanupFailure,
  retryRegularFileCleanup,
} from "./RegularFileRead.js";
import {
  NonRegularFileReadError,
  RegularFileChangedError,
} from "../filesystem/RegularFile.js";

/** The publishing operation that owns a saved-capture read. */
export interface WebCaptureReader<Selected> {
  readonly operation: WebCaptureExportOperation;
  readonly providerId: string;
  readonly error: WebCaptureExportErrorFactory;
  /** Validate the parsed JSON and select its exportable content, or throw. */
  readonly select: (json: unknown) => Selected;
}

interface CaptureRead {
  readonly bytes: Buffer;
  readonly cleanup?: {
    readonly reason: string;
    readonly incomplete: boolean;
    readonly cause: unknown;
  };
}

/** Read, decode and select one caller-selected saved capture file. */
export const readSavedWebCapture = async <Selected>(
  path: string,
  reader: WebCaptureReader<Selected>,
  resources: ArtifactResourceScope,
  signal: AbortSignal | undefined,
): Promise<
  Result<{ readonly bytes: Buffer; readonly loaded: Selected }, AnalysisError>
> => {
  const read = await resources.run(() =>
    readCapture(path, reader, resources, signal),
  );
  if (!read.ok) return read;
  const cleanup = read.value.cleanup;
  const loaded = parseCapture(
    read.value.bytes,
    reader,
    cleanup === undefined || cleanup.incomplete
      ? undefined
      : { cause: cleanup.cause },
  );
  if (!loaded.ok)
    return err(
      cleanup?.incomplete === true
        ? incompleteCaptureCleanup(loaded.error, path, reader, cleanup)
        : loaded.error,
    );
  if (cleanup !== undefined) {
    const primary = reader.error(
      "io",
      path,
      `Capture handle close failed: ${cleanup.reason}`,
      { cause: cleanup.cause },
    );
    return err(
      cleanup.incomplete
        ? incompleteCaptureCleanup(primary, path, reader, cleanup)
        : primary,
    );
  }
  return ok({ bytes: read.value.bytes, loaded: loaded.value });
};

/** Map a publication failure to the operation's typed error. */
export const mapWebCaptureExportFailure = (
  cause: unknown,
  reader: Pick<WebCaptureReader<unknown>, "operation" | "providerId" | "error">,
  paths: { readonly capturePath: string; readonly outputDirectory: string },
  signal: AbortSignal | undefined,
): AnalysisError => {
  if (cause instanceof WebCaptureExportError) return cause;
  if (cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined)
    return analysisErrorWithCleanupFailure(
      reader.error(cause.reason, paths.outputDirectory, cause.message, {
        cause,
      }),
      new ProviderCleanupError(
        reader.providerId,
        cause.cleanup.resources,
        { reason: cause.cleanup.reason },
        { cause, operation: reader.operation },
      ),
      reader.operation,
    );
  if (signal?.aborted === true)
    return new AnalysisCancelledError(reader.operation, { cause });
  if (cause instanceof ArtifactReaderFailure)
    return reader.error(cause.reason, paths.outputDirectory, cause.message, {
      cause,
    });
  if (cause instanceof z.ZodError)
    return new AnalysisOutputError(reader.operation, cause.message, { cause });
  if (
    cause instanceof Error &&
    "code" in cause &&
    typeof cause.code === "string"
  )
    return reader.error(
      "io",
      `${paths.capturePath} → ${paths.outputDirectory}`,
      cause.message,
      { cause },
    );
  return new ProviderAdapterError(reader.providerId, reader.operation, {
    cause,
    diagnostics: {
      capture_path: paths.capturePath,
      output_directory: paths.outputDirectory,
      error_name: cause instanceof Error ? cause.name : "UnknownError",
      error_message:
        cause instanceof Error
          ? cause.message
          : typeof cause === "string"
            ? cause
            : "Unknown web capture export failure",
    },
  });
};

/**
 * Read the caller-selected capture. A missing, non-file or unreadable
 * selection is a caller or host-permission failure, not an export failure.
 */
const readCapture = async (
  path: string,
  reader: WebCaptureReader<unknown>,
  resources: ArtifactResourceScope,
  signal: AbortSignal | undefined,
): Promise<Result<CaptureRead, AnalysisError>> => {
  try {
    return ok({ bytes: await readRegularFile(path, { signal }) });
  } catch (cause: unknown) {
    if (signal?.aborted === true && cause === signal.reason)
      return err(captureReadFailure(path, reader, cause, signal));
    if (cause instanceof RegularFileCleanupFailure) {
      const retry = await retryRegularFileCleanup(cause, resources, signal);
      const cleanup = {
        reason: retry.cleanup?.reason ?? errorMessage(cause.cleanupCause),
        incomplete: retry.cleanup !== undefined,
        cause: cause.cleanupCause,
      };
      if (retry.outcome.kind === "completed")
        return ok({ bytes: retry.outcome.value as Buffer, cleanup });
      const primary = captureReadFailure(
        path,
        reader,
        retry.outcome.cause,
        signal,
        retry.cleanup === undefined ? { cause: cause.cleanupCause } : undefined,
      );
      return err(
        retry.cleanup === undefined
          ? primary
          : incompleteCaptureCleanup(primary, path, reader, cleanup),
      );
    }
    return err(captureReadFailure(path, reader, cause, signal));
  }
};

const captureReadFailure = (
  path: string,
  reader: WebCaptureReader<unknown>,
  cause: unknown,
  signal: AbortSignal | undefined,
  closeFailure?: { readonly cause: unknown },
): AnalysisError => {
  const causeWithClose =
    closeFailure === undefined
      ? cause
      : new AggregateError(
          [cause, closeFailure.cause],
          "Capture read and file-handle close both failed",
          { cause },
        );
  if (signal?.aborted === true)
    return new AnalysisCancelledError(reader.operation, {
      cause: causeWithClose,
    });
  const code =
    cause instanceof Error && "code" in cause ? String(cause.code) : "";
  if (code === "EACCES" || code === "EPERM")
    return new AnalysisAccessDeniedError(reader.operation, path, code, {
      cause: causeWithClose,
    });
  if (
    cause instanceof NonRegularFileReadError ||
    cause instanceof RegularFileChangedError ||
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    code === "EISDIR" ||
    code === "ENXIO"
  )
    return new AnalysisInputError(reader.operation, { cause: causeWithClose }, [
      {
        path: ["capture_path"],
        reason: "invalid_value",
        message:
          cause instanceof NonRegularFileReadError && code !== "EISDIR"
            ? cause.message
            : code === "EISDIR"
              ? `Selected capture is a directory, not a file: ${path}`
              : `Selected capture could not be read (${code}): ${path}`,
      },
    ]);
  if (code !== "")
    return reader.error("io", path, errorMessage(cause), {
      cause: causeWithClose,
    });
  return new ProviderAdapterError(reader.providerId, reader.operation, {
    cause: causeWithClose,
    diagnostics: {
      capture_path: path,
      error_name: cause instanceof Error ? cause.name : "UnknownError",
      error_message: cause instanceof Error ? cause.message : String(cause),
    },
  });
};

const incompleteCaptureCleanup = (
  primary: AnalysisError,
  path: string,
  reader: WebCaptureReader<unknown>,
  cleanup: NonNullable<CaptureRead["cleanup"]>,
): AnalysisError =>
  analysisErrorWithCleanupFailure(
    primary,
    new ProviderCleanupError(
      reader.providerId,
      [path],
      { reason: cleanup.reason },
      { cause: cleanup.cause, operation: reader.operation },
    ),
    reader.operation,
  );

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const parseCapture = <Selected>(
  bytes: Buffer,
  reader: WebCaptureReader<Selected>,
  closeFailure?: { readonly cause: unknown },
): Result<Selected, AnalysisError> => {
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    const json = safeParseJson(text);
    if (!json.ok) throw new TypeError(json.error);
    return ok(reader.select(json.value));
  } catch (cause: unknown) {
    const causeWithClose =
      closeFailure === undefined
        ? cause
        : new AggregateError(
            [cause, closeFailure.cause],
            "Capture parse and file-handle close both failed",
            { cause },
          );
    return err(
      new AnalysisInputError(reader.operation, { cause: causeWithClose }, [
        {
          path: ["capture_path"],
          reason: "invalid_format",
          message:
            cause instanceof Error
              ? cause.message
              : "Capture is not valid UTF-8 JSON evidence.",
        },
      ]),
    );
  }
};
