import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import type { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { DESTINATION_CASE_COLLISION_PREFIX } from "../../artifacts/ArtifactPaths.js";
import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import { SafeOutputTreeCreationFailure } from "../../artifacts/SafeOutputTreeCreationFailure.js";
import type { AnalysisPartialObservation } from "../../domain/analysisErrorBase.js";
import type { WebCaptureExportErrorFactory } from "../../domain/webScriptExportError.js";

/** One publication's ownership, cancellation and failure projection. */
export interface OutputTreePublication<Result> {
  readonly outputDirectory: string;
  readonly resources: ArtifactResourceScope;
  readonly signal?: AbortSignal;
  readonly error: WebCaptureExportErrorFactory;
  readonly partialObservation: (result: Result) => AnalysisPartialObservation;
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
  cause instanceof ArtifactReaderFailure &&
  cause.reason === "path" &&
  cause.message.startsWith(DESTINATION_CASE_COLLISION_PREFIX)
    ? cause.message
    : undefined;

/**
 * Exclusively create the absent output directory, let `publish` write its
 * verified files, write manifest.json last and commit. Any failure releases
 * the owned tree, which rolls back partial output; a failed rollback or a
 * failed descriptor cleanup after commit reports the residual directory.
 */
export const publishOutputTree = async <Result>(
  publication: OutputTreePublication<Result>,
  publish: (tree: SafeOutputTree) => Promise<{
    readonly result: Result;
    readonly manifest: { readonly bytes: Buffer; readonly sha256: string };
  }>,
): Promise<Result> =>
  publication.resources.run(async () => {
    const { signal } = publication;
    let tree: SafeOutputTree | undefined;
    let result: Result | undefined;
    try {
      tree = await SafeOutputTree.create(publication.outputDirectory);
      signal?.throwIfAborted();
      const published = await publish(tree);
      result = published.result;
      await writeTreeFile(
        tree,
        "manifest.json",
        published.manifest.bytes,
        published.manifest.sha256,
        signal,
      );
      signal?.throwIfAborted();
      await tree.commit(signal);
      return result;
    } catch (cause: unknown) {
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
          const error = publication.error(
            cause instanceof ArtifactReaderFailure ? cause.reason : "io",
            tree.outputRoot,
            diagnostic,
            { residualPaths: [tree.outputRoot] },
          );
          if (tree.published && result !== undefined)
            error.retainPartialObservation(
              publication.partialObservation(result),
            );
          throw error;
        }
        if (tree.published && result !== undefined) return result;
      }
      throw cause;
    }
  });

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "Unknown publication failure";
