import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename } from "node:path";
import { pipeline } from "node:stream/promises";

import { AnalysisError } from "../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../domain/result.js";
import { translateArtifactFailure } from "./ArtifactOperationFailure.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import type { ArtifactResourceScope } from "./ArtifactResourceScope.js";
import { extractArtifactWithInventory } from "./extraction/ArtifactExtraction.js";
import { SafeOutputTree } from "./SafeOutputTree.js";
import { SafeOutputTreeCreationFailure } from "./SafeOutputTreeCreationFailure.js";

const OPERATION = "clone_local_application";

/** Facts about one verified local application copy. */
export interface LocalApplicationCopyFacts {
  readonly files: number;
  readonly bytes: number;
  readonly filesSha256: string | null;
  readonly extractionId: string | null;
  readonly limitations: readonly string[];
}

export interface LocalApplicationCopyRequest {
  readonly root: string;
  readonly rootKind: "directory" | "file";
  readonly outputDirectory: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly resources: ArtifactResourceScope;
}

/**
 * Copy an installed application into an absent directory. Directories use
 * the artifact extraction owner (no symlink following, digest-verified
 * writes, rollback); a single file is digested, then written and re-verified.
 */
export const copyLocalApplication = async (
  request: LocalApplicationCopyRequest,
  signal?: AbortSignal,
): Promise<Result<LocalApplicationCopyFacts, AnalysisError>> => {
  try {
    if (request.rootKind === "directory") {
      const { result, inventory } = await extractArtifactWithInventory(
        {
          inputPath: request.root,
          inputFormat: "directory",
          outputRoot: request.outputDirectory,
          environment: request.environment,
          integrityPolicy: "fail",
          resourceScope: request.resources,
        },
        signal,
      );
      return ok({
        files: result.artifacts.length,
        bytes: result.artifacts.reduce(
          (sum, artifact) => sum + artifact.bytes_written,
          0,
        ),
        filesSha256: result.extraction_manifest.files_sha256,
        extractionId: result.extraction_manifest.extraction_id,
        limitations: [
          ...result.limitations,
          ...omittedEntries(inventory.occurrences),
        ],
      });
    }
    return ok(await copyFile(request, signal));
  } catch (cause: unknown) {
    return err(
      translateArtifactFailure(
        OPERATION,
        copyFailure(request.root, cause, signal),
      ),
    );
  }
};

/** Entries a copy of regular files cannot reproduce, stated rather than dropped. */
const omittedEntries = (
  occurrences: readonly { readonly entry_kind: string }[],
): string[] => {
  const symlinks = occurrences.filter(
    ({ entry_kind }) => entry_kind === "symlink",
  ).length;
  return symlinks === 0
    ? []
    : [
        `${symlinks} symbolic link${symlinks === 1 ? " was" : "s were"} not recreated and not followed; files they point to outside the copied tree are not included. Directories holding no regular files are not recreated.`,
      ];
};

const digestFile = async (
  path: string,
  signal: AbortSignal | undefined,
): Promise<{ readonly sha256: string; readonly bytes: number }> => {
  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(
    createReadStream(path),
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        hash.update(chunk);
        bytes += chunk.length;
      }
      yield* [];
    },
    signal === undefined ? {} : { signal },
  );
  return { sha256: hash.digest("hex"), bytes };
};

const copyFile = async (
  request: LocalApplicationCopyRequest,
  signal: AbortSignal | undefined,
): Promise<LocalApplicationCopyFacts> =>
  request.resources.run(async () => {
    const metadata = await lstat(request.root);
    if (!metadata.isFile())
      throw new ArtifactReaderFailure(
        "path",
        `Selected application file is not a regular file: ${request.root}`,
      );
    const expected = await digestFile(request.root, signal);
    let tree: SafeOutputTree | undefined;
    let facts: LocalApplicationCopyFacts | undefined;
    try {
      tree = await SafeOutputTree.create(request.outputDirectory);
      // The write re-hashes the streamed bytes, so a file that changed after
      // digesting fails instead of producing a mismatched copy.
      await tree.write(
        basename(request.root),
        createReadStream(request.root),
        expected,
        signal,
      );
      facts = {
        files: 1,
        bytes: expected.bytes,
        filesSha256: expected.sha256,
        extractionId: null,
        limitations: [
          "A single executable file was copied; libraries, resources and data it loads from other locations are not included.",
        ],
      };
      await tree.commit(signal);
      return facts;
    } catch (cause: unknown) {
      if (cause instanceof SafeOutputTreeCreationFailure) tree = cause.tree;
      if (tree === undefined) throw cause;
      // Release rolls back unpublished output and retries descriptor cleanup
      // after a publication; a failed attempt stays owned by the scope.
      const cleanup = await request.resources.release({
        kind: "output-tree",
        resource: tree.outputRoot,
        tree,
      });
      if (cleanup.kind === "failed")
        throw request.resources.cleanupFailure({ kind: "failed", cause }, [
          cleanup,
        ]);
      if (tree.published && facts !== undefined) return facts;
      throw cause;
    }
  });

/**
 * Keep typed failures; name the caller's cancellation and the source path of
 * a raw host failure instead of reducing them to an anonymous I/O error.
 */
const copyFailure = (
  path: string,
  cause: unknown,
  signal: AbortSignal | undefined,
): unknown => {
  if (cause instanceof ArtifactReaderFailure || cause instanceof AnalysisError)
    return cause;
  if (signal?.aborted === true)
    return new ArtifactReaderFailure(
      "cancelled",
      "Application copy was cancelled.",
      {
        cause,
        cancellation: { reason: signal.reason },
      },
    );
  const code =
    cause instanceof Error && "code" in cause ? String(cause.code) : "";
  return new ArtifactReaderFailure(
    code === "ENOENT" || code === "ENOTDIR" ? "path" : "io",
    `Could not read the application at ${path}${code === "" ? "" : ` (${code})`}: ${cause instanceof Error ? cause.message : String(cause)}`,
    { cause },
  );
};
