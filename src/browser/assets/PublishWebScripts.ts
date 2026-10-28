import { join } from "node:path";

import type { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import type { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import { PLAYWRIGHT_RESPONSE_BODY_PROVENANCE_LIMITATION } from "../../domain/browserNetworkEvidence.js";
import {
  webScriptExportManifestSchema,
  webScriptExportResultSchema,
  type ExportWebScriptsInput,
  type ExportedWebScript,
  type WebScriptExportResult,
} from "../../domain/webScriptExport.js";
import {
  isolatedWebScriptPath,
  planWebScriptExport,
  type PlannedWebScript,
} from "../../domain/webScriptExportPlan.js";
import { WebScriptExportError } from "../../domain/webScriptExportError.js";
import {
  destinationCollisionReason,
  manifestBytes,
  publishOutputTree,
  writeTreeFile,
} from "./PublishOutputTree.js";
import type { SelectedScriptCapture } from "./ScriptCaptureAdapters.js";

const LIMITATIONS = [
  "Only script bytes retained in this capture are exported. Sources are not refetched or executed, and a response or Debugger source does not prove execution.",
  "Ordinary unambiguous URL paths preserve relative module layouts by origin, including case-distinct spellings. Query variants, exact path collisions, file/directory prefixes, inline sources, and unrepresentable paths are isolated. A case-distinct pair is isolated only when the destination filesystem cannot store both spellings; the record names that pair. Browser module relationships of isolated paths remain unknown.",
  "Local JavaScript analysis does not implement browser import maps, root-relative URL resolution, remote URL loading, or browser runtime behavior. It may strip import queries and fragments; isolated variants are not canonical targets.",
  "Source-map declarations are retained as metadata. No source maps or missing dependencies are fetched or reconstructed.",
  "Scenario response bytes preserve the output of Playwright's Response.body() API; any source-body provenance caveat from the capture is retained in this manifest. Debugger sources are the exposed text encoded as UTF-8. Redacted bytes are exported exactly as retained, and may no longer parse as JavaScript.",
];

interface PublishWebScriptsOptions {
  readonly resources: ArtifactResourceScope;
  readonly signal?: AbortSignal;
}

/** Exclusively publish verified bytes and a manifest, rolling back partial work. */
export const publishWebScripts = async (
  input: ExportWebScriptsInput,
  capture: SelectedScriptCapture & { readonly sourceEvidenceId: string | null },
  captureSha256: string,
  options: PublishWebScriptsOptions,
): Promise<WebScriptExportResult> => {
  const planned = planWebScriptExport(capture.scripts);
  const scenarioResponseBodyCaptured =
    capture.kind === "browser-scenario" &&
    capture.scripts.some(
      (script) =>
        script.source.kind === "scenario-response" &&
        script.content.state === "captured" &&
        (script.content.representation === "playwright-response-body-bytes" ||
          script.content.representation === "browser-decoded-response-bytes"),
    );
  const responseBodyProvenanceLimitations =
    scenarioResponseBodyCaptured &&
    !capture.limitations.includes(
      PLAYWRIGHT_RESPONSE_BODY_PROVENANCE_LIMITATION,
    )
      ? [PLAYWRIGHT_RESPONSE_BODY_PROVENANCE_LIMITATION]
      : [];
  return publishOutputTree<WebScriptExportResult>(
    {
      operation: "export_web_scripts",
      outputDirectory: input.output_directory,
      resources: options.resources,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      error: (reason, target, diagnostic, errorOptions) =>
        new WebScriptExportError(reason, target, diagnostic, errorOptions),
      partialObservation: (result) => ({ kind: "web-script-export", result }),
    },
    async ({ tree, assertActive }) => {
      const records: ExportedWebScript[] = [];
      for (const [index, item] of planned.entries()) {
        assertActive();
        records.push(
          await publishPlannedScript(tree, item, index, options.signal),
        );
      }
      const manifest = webScriptExportManifestSchema.parse({
        capture_path: input.capture_path,
        capture_sha256: captureSha256,
        capture_kind: capture.kind,
        source_evidence_id: capture.sourceEvidenceId,
        capture_completeness: capture.completeness,
        output_directory: tree.outputRoot,
        analysis_input: records.some(
          ({ content }) => content.state === "exported",
        )
          ? { input_path: join(tree.outputRoot, "files"), format: "directory" }
          : null,
        scripts: records,
        limitations: [
          ...capture.limitations,
          ...responseBodyProvenanceLimitations,
          ...LIMITATIONS,
          ...(records.some(({ content }) => content.state === "exported")
            ? []
            : [
                "No script bytes were exportable. Include script sources in inspect_web_page or select response_body in capture_browser_scenario, then capture again.",
              ]),
        ],
      });
      const persisted = manifestBytes(manifest);
      return {
        manifest: persisted,
        result: webScriptExportResultSchema.parse({
          ...manifest,
          manifest: {
            path: join(tree.outputRoot, "manifest.json"),
            sha256: persisted.sha256,
            bytes: persisted.bytes.length,
          },
        }),
      };
    },
  );
};

const publishPlannedScript = async (
  tree: SafeOutputTree,
  item: PlannedWebScript,
  index: number,
  signal: AbortSignal | undefined,
): Promise<ExportedWebScript> => {
  const { script, record } = item;
  const content = script.content;
  if (content.state !== "captured" || record.content.state !== "exported")
    return record;
  const write = (relativePath: string): Promise<unknown> =>
    writeTreeFile(
      tree,
      `files/${relativePath}`,
      content.bytes,
      content.sha256,
      signal,
    );
  try {
    await write(record.content.relative_path);
    return record;
  } catch (cause: unknown) {
    const collision = destinationCollisionReason(cause);
    if (collision === undefined || record.content.layout !== "url-path")
      throw cause;
    const relativePath = isolatedWebScriptPath(script.source, index);
    await write(relativePath);
    return {
      ...record,
      content: {
        ...record.content,
        relative_path: relativePath,
        layout: "isolated",
        layout_reason: collision,
      },
    };
  }
};
