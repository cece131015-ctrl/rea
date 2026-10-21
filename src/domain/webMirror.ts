import { z } from "zod";

import { browserScenarioCompletenessSchema } from "./browserScenarioCaptureValues.js";
import { digestSchema, prefixedDigestSchema } from "./digests.js";
import { localPathStringSchema } from "./localPath.js";

/** Mirror one saved browser scenario capture into one absent directory. */
export const exportWebMirrorInputSchema = z.strictObject({
  capture_path: localPathStringSchema.describe(
    "Absolute filesystem path to saved capture_browser_scenario JSON (normalized result or complete Evidence) captured with capture.network.response_body",
  ),
  output_directory: localPathStringSchema.describe(
    "Absolute absent filesystem directory for exact files, the browsable view and the manifest; parent directory must exist",
  ),
});
export type ExportWebMirrorInput = z.output<typeof exportWebMirrorInputSchema>;

const MEBIBYTE = 1024 * 1024;

/** Ceiling for one retained response body in a website clone. */
export const CLONE_WEBSITE_MAX_RESOURCE_BYTES = 64 * MEBIBYTE;
/** Ceiling for all retained response bodies in a website clone. */
export const CLONE_WEBSITE_MAX_TOTAL_BYTES = 512 * MEBIBYTE;

/** Capture one page (and optional extra pages) live, then mirror it. */
export const cloneWebsiteInputSchema = z.strictObject({
  url: z
    .string()
    .min(1)
    .describe(
      "HTTP(S) URL of the page to clone; the browser loads it and runs its JavaScript",
    ),
  output_directory: localPathStringSchema.describe(
    "Absolute absent filesystem directory for the capture, exact files, the browsable view and the manifest; parent directory must exist",
  ),
  browser_executable_path: localPathStringSchema
    .optional()
    .describe(
      "Absolute path to a Chrome or Chromium-family executable; defaults to REA_BROWSER_EXECUTABLE",
    ),
  additional_urls: z
    .array(z.string().min(1))
    .max(20)
    .default([])
    .describe(
      "Further HTTP(S) pages to visit in the same browser session after the first page, in order",
    ),
  settle_ms: z
    .number()
    .int()
    .min(0)
    .max(60_000)
    .default(1_000)
    .describe(
      "Milliseconds to keep observing each page after its load event so late requests are captured",
    ),
  max_resource_bytes: z
    .number()
    .int()
    .min(1)
    .max(CLONE_WEBSITE_MAX_RESOURCE_BYTES)
    .default(16 * MEBIBYTE)
    .describe(
      "Largest single response body to retain; larger bodies are recorded as unavailable",
    ),
  max_total_bytes: z
    .number()
    .int()
    .min(1)
    .max(CLONE_WEBSITE_MAX_TOTAL_BYTES)
    .default(128 * MEBIBYTE)
    .describe(
      "Approximate budget for all retained response bodies; bodies beyond it are recorded as unavailable",
    ),
  max_resources: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(2_048)
    .describe("Most network transactions to record across all pages"),
  headless: z
    .boolean()
    .default(true)
    .describe("Run the browser without a visible window"),
});
export type CloneWebsiteInput = z.output<typeof cloneWebsiteInputSchema>;

/** Response body bytes retained by a capture, still base64-encoded. */
export interface CapturedWebResourceBody {
  readonly state: "captured";
  readonly base64: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly media_type: string | null;
  readonly redacted: boolean | null;
  readonly representation:
    | "playwright-response-body-bytes"
    | "browser-decoded-response-bytes";
}

const webResourceSourceSchema = z.strictObject({
  kind: z.literal("scenario-response"),
  transaction_id: z.string().min(1),
  request_sequence: z.number().int().min(1),
  response_sequence: z.number().int().min(1).nullable(),
  status: z.number().nullable(),
});

/** One observed request joined to its single response and retained bytes. */
export interface CapturedWebResource {
  readonly source: z.output<typeof webResourceSourceSchema>;
  readonly method: string;
  readonly url: string;
  readonly resource_type: string;
  readonly redirected_from_transaction_id: string | null;
  readonly content:
    | CapturedWebResourceBody
    | {
        readonly state: "unavailable";
        readonly reason: string;
        readonly message: string;
      };
}

const outputPathSchema = z.string().min(1);

/** The persisted record of one captured transaction and its mirror outcome. */
export const webMirrorResourceSchema = z.strictObject({
  source: webResourceSourceSchema,
  method: z.string().min(1),
  url: z.string(),
  resource_type: z.string().min(1),
  media_type: z.string().nullable(),
  content: z.discriminatedUnion("state", [
    z.strictObject({
      state: z.literal("exported"),
      /** Output-root relative path of the exact retained bytes. */
      relative_path: outputPathSchema,
      layout: z.enum(["url-path", "isolated"]),
      layout_reason: z.string().nullable(),
      sha256: digestSchema,
      bytes: z.number().int().min(0),
      redacted: z.boolean().nullable(),
      representation: z.enum([
        "playwright-response-body-bytes",
        "browser-decoded-response-bytes",
      ]),
    }),
    z.strictObject({
      state: z.literal("redirect"),
      to_transaction_id: z.string().min(1),
    }),
    z.strictObject({
      state: z.literal("unavailable"),
      reason: z.string().min(1),
      message: z.string().min(1),
    }),
  ]),
  view: z
    .strictObject({
      relative_path: outputPathSchema,
      sha256: digestSchema,
      bytes: z.number().int().min(0),
      rewritten_references: z.number().int().min(0),
      unresolved_references: z.number().int().min(0),
      removed_attributes: z.number().int().min(0),
    })
    .nullable(),
});
export type WebMirrorResource = z.output<typeof webMirrorResourceSchema>;

const coverageSchema = z.strictObject({
  transactions: z.number().int().min(0),
  exported: z.number().int().min(0),
  files: z.number().int().min(0),
  redirects: z.number().int().min(0),
  unavailable: z.number().int().min(0),
  views: z.number().int().min(0),
  rewritten_references: z.number().int().min(0),
  unresolved_references: z.number().int().min(0),
});

const captureSchema = z.strictObject({
  path: z.string().min(1),
  sha256: digestSchema,
  kind: z.literal("browser-scenario"),
  source_evidence_id: prefixedDigestSchema("ev").nullable(),
  completeness: browserScenarioCompletenessSchema,
});

const entrySchema = z
  .strictObject({
    url: z.string(),
    file_path: outputPathSchema,
    view_path: outputPathSchema.nullable(),
    /** Generated redirect page at the output root; not captured content. */
    open_path: z.literal("index.html"),
  })
  .nullable();

/** Persisted manifest; resource bytes stay on disk. */
export const webMirrorManifestSchema = z.strictObject({
  capture: captureSchema,
  output_directory: z.string().min(1),
  entry: entrySchema,
  resources: z.array(webMirrorResourceSchema),
  coverage: coverageSchema,
  limitations: z.array(z.string()),
});

/** Inline answers name at most this many unavailable resources. */
export const WEB_MIRROR_INLINE_UNAVAILABLE_LIMIT = 50;

/** Token-lean inline result; complete per-resource records are in the manifest. */
export const webMirrorExportResultSchema = z.strictObject({
  capture: captureSchema,
  output_directory: z.string().min(1),
  entry: entrySchema,
  coverage: coverageSchema,
  unavailable: z
    .array(
      z.strictObject({
        url: z.string(),
        resource_type: z.string().min(1),
        reason: z.string().min(1),
      }),
    )
    .max(WEB_MIRROR_INLINE_UNAVAILABLE_LIMIT),
  unavailable_omitted: z.number().int().min(0),
  manifest: z.strictObject({
    path: z.string().min(1),
    sha256: digestSchema,
    bytes: z.number().int().min(0),
  }),
  limitations: z.array(z.string()),
});
export type WebMirrorExportResult = z.output<
  typeof webMirrorExportResultSchema
>;

/** Completed publication retained when cleanup fails after durable commit. */
export interface WebMirrorExportPartialObservation {
  readonly kind: "web-mirror-export";
  readonly result: WebMirrorExportResult;
}
