import { z } from "zod";

import {
  AnalysisCleanupLeaseGroup,
  type AnalysisCleanupLease,
} from "../artifacts/AnalysisCleanupLease.js";
import { bindArtifactFileCleanup } from "../artifacts/ArtifactFileOperation.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  AnalysisAccessDeniedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import { safeParseJson } from "../domain/safeJson.js";
import type {
  WebCaptureExportErrorFactory,
  WebCaptureExportOperation,
} from "../domain/webScriptExportError.js";
import {
  NonRegularFileReadError,
  RegularFileChangedError,
  RegularFileOperationCancelled,
} from "../filesystem/RegularFile.js";
import {
  RegularFileCleanupFailure,
  regularFileCancellation,
} from "../filesystem/OwnedRegularFile.js";
import {
  readRegularFile,
  RegularFileReadFailure,
  retryRegularFileCleanup,
} from "./RegularFileRead.js";

/** The publishing operation that owns a saved-capture read. */
export interface WebCaptureReader<Selected> {
  readonly operation: WebCaptureExportOperation;
  readonly providerId: string;
  readonly error: WebCaptureExportErrorFactory;
  /** Validate the parsed JSON and select its exportable content, or throw. */
  readonly select: (json: unknown) => Selected;
}

type CaptureOwner = Pick<
  WebCaptureReader<unknown>,
  "operation" | "providerId" | "error"
>;

interface CaptureRead {
  readonly bytes: Buffer;
  readonly cleanup?: {
    readonly reason: string;
    readonly incomplete: boolean;
    readonly cause: unknown;
    readonly lease?: AnalysisCleanupLease;
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
  owner: CaptureOwner,
  paths: { readonly capturePath: string; readonly outputDirectory: string },
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof ArtifactReaderFailure) {
    const primary =
      cause.cancellation === undefined
        ? owner.error(cause.reason, paths.outputDirectory, cause.message, {
            cause,
            partialObservation: cause.partialObservation,
          })
        : new AnalysisCancelledError(owner.operation, {
            cause: cause.cancellation.reason,
            partialObservation: cause.partialObservation,
          });
    if (cause.cleanup === undefined) return primary;
    const error = analysisErrorWithCleanupFailure(
      primary,
      new ProviderCleanupError(
        owner.providerId,
        cause.cleanup.resources,
        { reason: cause.cleanup.reason },
        { cause, operation: owner.operation },
      ),
      owner.operation,
    );
    bindArtifactFileCleanup(cause, error);
    return error;
  }
  if (cause instanceof z.ZodError)
    return new AnalysisOutputError(owner.operation, cause.message, { cause });
  if (
    cause instanceof Error &&
    "code" in cause &&
    typeof cause.code === "string"
  )
    return owner.error(
      "io",
      `${paths.capturePath} → ${paths.outputDirectory}`,
      cause.message,
      { cause },
    );
  return new ProviderAdapterError(owner.providerId, owner.operation, {
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
  owner: CaptureOwner,
  resources: ArtifactResourceScope,
  signal: AbortSignal | undefined,
): Promise<Result<CaptureRead, AnalysisError>> => {
  try {
    return ok({
      bytes: await readRegularFile(path, {
        signal,
        cancellationFailure: (reason) =>
          new RegularFileOperationCancelled(reason),
      }),
    });
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) {
      const retry = await retryRegularFileCleanup(cause, resources, signal);
      const cleanup = {
        reason: retry.cleanup?.reason ?? errorMessage(cause.cleanupCause),
        incomplete: retry.cleanup !== undefined,
        cause: cause.cleanupCause,
        ...(retry.cleanupLease === undefined
          ? {}
          : { lease: retry.cleanupLease }),
      };
      if (retry.outcome.kind === "completed") {
        const cancellation =
          signal?.aborted === true
            ? { reason: signal.reason }
            : regularFileCancellation(cause);
        if (cancellation !== undefined) {
          const primary = new AnalysisCancelledError(owner.operation, {
            cause: cancellation.reason,
          });
          return err(
            retry.cleanup === undefined
              ? primary
              : incompleteCaptureCleanup(primary, path, owner, cleanup),
          );
        }
        return ok({ bytes: retry.outcome.value as Buffer, cleanup });
      }
      const primary = captureReadFailure(
        path,
        owner,
        cause,
        retry.cleanup === undefined ? { cause: cause.cleanupCause } : undefined,
      );
      return err(
        retry.cleanup === undefined
          ? primary
          : incompleteCaptureCleanup(primary, path, owner, cleanup),
      );
    }
    return err(captureReadFailure(path, owner, cause));
  }
};

const captureReadFailure = (
  path: string,
  owner: CaptureOwner,
  failure: unknown,
  closeFailure?: { readonly cause: unknown },
): AnalysisError => {
  const cancellation = regularFileCancellation(failure);
  if (cancellation !== undefined)
    return new AnalysisCancelledError(owner.operation, {
      cause: cancellation.reason,
    });
  const primary =
    failure instanceof RegularFileCleanupFailure &&
    failure.outcome.kind === "failed"
      ? (failure.operationFailure ?? failure.outcome.cause)
      : failure;
  const cause =
    primary instanceof RegularFileReadFailure
      ? primary.operationCause
      : primary;
  const causeWithClose =
    closeFailure === undefined
      ? cause
      : new AggregateError(
          [cause, closeFailure.cause],
          "Capture read and file-handle close both failed",
          { cause },
        );
  const code =
    cause instanceof Error && "code" in cause ? String(cause.code) : "";
  if (code === "EACCES" || code === "EPERM")
    return new AnalysisAccessDeniedError(owner.operation, path, code, {
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
    return new AnalysisInputError(owner.operation, { cause: causeWithClose }, [
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
    return owner.error("io", path, errorMessage(cause), {
      cause: causeWithClose,
    });
  return new ProviderAdapterError(owner.providerId, owner.operation, {
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
  owner: CaptureOwner,
  cleanup: NonNullable<CaptureRead["cleanup"]>,
): AnalysisError => {
  const error = analysisErrorWithCleanupFailure(
    primary,
    new ProviderCleanupError(
      owner.providerId,
      [path],
      { reason: cleanup.reason },
      { cause: cleanup.cause, operation: owner.operation },
    ),
    owner.operation,
  );
  if (cleanup.lease !== undefined)
    new AnalysisCleanupLeaseGroup(error, [cleanup.lease]);
  return error;
};

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
