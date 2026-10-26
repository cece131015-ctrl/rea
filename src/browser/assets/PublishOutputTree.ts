import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import type { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { DestinationCaseCollisionFailure } from "../../artifacts/ArtifactPaths.js";
import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import { outputDirectoryAdmissionRefusal } from "../../artifacts/SafeOutputTreeAdmission.js";
import { SafeOutputTreeCreationFailure } from "../../artifacts/SafeOutputTreeCreationFailure.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import type { AnalysisPartialObservation } from "../../domain/analysisErrorBase.js";
import type {
  WebCaptureExportErrorFactory,
  WebCaptureExportOperation,
} from "../../domain/webScriptExportError.js";

/** One publication's ownership, cancellation and failure projection. */
export interface OutputTreePublication<Result> {
  readonly operation: WebCaptureExportOperation;
  readonly outputDirectory: string;
  readonly resources: ArtifactResourceScope;
  readonly signal?: AbortSignal;
  readonly error: WebCaptureExportErrorFactory;
  readonly partialObservation: (result: Result) => AnalysisPartialObservation;
}

/** What a publish stage receives: the owned tree and the cancellation check. */
export interface OutputTreeWriter {
  readonly tree: SafeOutputTree;
  /** Throw the operation's typed cancellation once the caller has aborted. */
  readonly assertActive: () => void;
}

/** Serialize a manifest exactly as it is persisted and digested. */
export const manifestBytes = (
  manifest: unknown,
): { readonly bytes: Buffer; readonly sha256: string } => {
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};

/** Write verified bytes into an owned tree. */
export const writeTreeFile = (
  tree: SafeOutputTree,
  relativePath: string,
  bytes: Buffer,
  sha256: string,
  signal: AbortSignal | undefined,
): Promise<unknown> =>
  tree.write(
    relativePath,
    Readable.from([bytes]),
    { sha256, bytes: bytes.byteLength },
    signal,
  );

/** The destination's case-collision diagnostic, when that is the failure. */
export const destinationCollisionReason = (
  cause: unknown,
): string | undefined =>
  cause instanceof DestinationCaseCollisionFailure ? cause.message : undefined;

/**
 * Exclusively create the absent output directory, let `publish` write its
 * verified files, write manifest.json last and commit. Any failure releases
 * the owned tree, which rolls back partial output; a failed rollback or a
 * failed descriptor cleanup after commit reports the residual directory and
 * keeps its cleanup owned.
 */
export const publishOutputTree = async <Result>(
  publication: OutputTreePublication<Result>,
  publish: (writer: OutputTreeWriter) => Promise<{
    readonly result: Result;
    readonly manifest: { readonly bytes: Buffer; readonly sha256: string };
  }>,
): Promise<Result> =>
  publication.resources.run(async () => {
    const { operation, signal } = publication;
    const assertActive = (): void => {
      if (signal?.aborted === true)
        throw new AnalysisCancelledError(operation, { cause: signal.reason });
    };
    let tree: SafeOutputTree | undefined;
    let result: Result | undefined;
    try {
      tree = await SafeOutputTree.create(publication.outputDirectory);
      assertActive();
      const published = await publish({ tree, assertActive });
      result = published.result;
      await writeTreeFile(
        tree,
        "manifest.json",
        published.manifest.bytes,
        published.manifest.sha256,
        signal,
      );
      assertActive();
      await tree.commit(signal);
      return result;
    } catch (cause: unknown) {
      const cancellation =
        cause instanceof AnalysisCancelledError
          ? cause
          : cause instanceof ArtifactReaderFailure &&
              cause.cancellation !== undefined
            ? new AnalysisCancelledError(operation, {
                cause: cause.cancellation.reason,
              })
            : undefined;
      if (cause instanceof SafeOutputTreeCreationFailure) tree = cause.tree;
      if (tree !== undefined) {
        const cleanup = await publication.resources.release({
          kind: "output-tree",
          resource: tree.outputRoot,
          tree,
        });
        if (cleanup.kind === "failed") {
          const diagnostic = tree.published
            ? `Publication completed, but descriptor cleanup failed (${message(cleanup.cause)}). The published output remains available.`
            : `Publication failed (${message(cause)}); rollback failed (${message(cleanup.cause)}). Remove the residual output directory before retrying.`;
          const partialObservation =
            tree.published && result !== undefined
              ? publication.partialObservation(result)
              : undefined;
          if (cancellation !== undefined) {
            const cancelled = new AnalysisCancelledError(operation, {
              cause: cancellation.cause,
              cleanup: { reason: diagnostic, resources: [tree.outputRoot] },
              ...(partialObservation === undefined
                ? {}
                : { partialObservation }),
            });
            cleanup.lease.bindCleanupError(cancelled);
            throw cancelled;
          }
          const error = publication.error(
            cause instanceof ArtifactReaderFailure ? cause.reason : "io",
            tree.outputRoot,
            diagnostic,
            { cause, residualPaths: [tree.outputRoot] },
          );
          if (partialObservation !== undefined)
            error.retainPartialObservation(partialObservation);
          cleanup.lease.bindCleanupError(error);
          throw error;
        }
        if (tree.published && result !== undefined) return result;
      }
      if (cancellation !== undefined) throw cancellation;
      // Only a destination refusal can blame the selected output directory.
      throw outputDirectoryAdmissionRefusal(
        operation,
        "output_directory",
        cause,
      );
    }
  });

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "Unknown publication failure";
