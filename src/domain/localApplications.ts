import { z } from "zod";

import { digestSchema } from "./digests.js";
import { localPathStringSchema } from "./localPath.js";

/** Matches beyond this many are counted, not listed. */
export const LOCAL_APPLICATION_MATCH_LIMIT = 200;
/** Directory entries read per search root before its coverage is partial. */
export const LOCAL_APPLICATION_ENTRY_LIMIT = 10_000;
/** Ambiguous selections list at most this many candidates. */
export const LOCAL_APPLICATION_CANDIDATE_LIMIT = 20;

const searchRootsSchema = z
  .array(localPathStringSchema)
  .min(1)
  .max(32)
  .optional()
  .describe(
    "Absolute directories to search instead of this platform's default application locations",
  );

/** Find installed applications on this computer by name. */
export const findLocalApplicationsInputSchema = z.strictObject({
  query: z
    .string()
    .trim()
    .min(2)
    .max(256)
    .describe(
      "Case-insensitive application name, bundle identifier, desktop entry name or install directory name to search for",
    ),
  search_roots: searchRootsSchema,
});
export type FindLocalApplicationsInput = z.output<
  typeof findLocalApplicationsInputSchema
>;

/** Copy one installed application into an absent directory. */
export const cloneLocalApplicationInputSchema = z.strictObject({
  application: z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .describe(
      "Absolute path of an installed application bundle, directory, desktop entry or executable, or a name to search for; a name must select exactly one application",
    ),
  output_directory: localPathStringSchema.describe(
    "Absolute absent filesystem directory for the verified copy; parent directory must exist",
  ),
  search_roots: searchRootsSchema,
});
export type CloneLocalApplicationInput = z.output<
  typeof cloneLocalApplicationInputSchema
>;

export const localApplicationKindSchema = z.enum([
  "macos-app-bundle",
  "desktop-entry",
  "program-directory",
  "appimage",
  "executable",
]);

/** One installed application and the files a copy would read. */
export const localApplicationSchema = z.strictObject({
  name: z.string().min(1),
  display_name: z.string().nullable(),
  bundle_identifier: z.string().nullable(),
  version: z.string().nullable(),
  kind: localApplicationKindSchema,
  /** The installed files a clone copies; null when they could not be resolved. */
  root_path: z.string().nullable(),
  root_kind: z.enum(["directory", "file"]).nullable(),
  executable_path: z.string().nullable(),
  /** The bundle, desktop entry, directory or file that declared the application. */
  source_path: z.string().min(1),
  electron_asar_paths: z.array(z.string()),
  matched_field: z.string().min(1),
  exact: z.boolean(),
  limitations: z.array(z.string()),
});
export type LocalApplication = z.output<typeof localApplicationSchema>;

const searchRootSchema = z.strictObject({
  path: z.string().min(1),
  strategy: z.enum([
    "macos-bundles",
    "desktop-entries",
    "program-directories",
    "appimages",
    "caller-selected",
  ]),
  state: z.enum(["scanned", "missing", "unreadable", "truncated", "partial"]),
  reason: z.string().nullable(),
  entries_read: z.number().int().min(0),
});
export type LocalApplicationSearchRoot = z.output<typeof searchRootSchema>;

/** Discovery answer: matched applications and the examined coverage. */
export const localApplicationDiscoverySchema = z.strictObject({
  query: z.string().min(1),
  platform: z.string().min(1),
  roots_source: z.enum(["platform-default", "caller-selected"]),
  roots: z.array(searchRootSchema),
  matches: z.array(localApplicationSchema).max(LOCAL_APPLICATION_MATCH_LIMIT),
  matches_omitted: z.number().int().min(0),
  exact_match_count: z.number().int().min(0),
  coverage: z.strictObject({
    status: z.enum(["complete", "partial"]),
    reasons: z.array(z.string()),
  }),
  limitations: z.array(z.string()),
});
export type LocalApplicationDiscovery = z.output<
  typeof localApplicationDiscoverySchema
>;

/** Verified copy of one installed application. */
export const localApplicationCloneSchema = z.strictObject({
  application: localApplicationSchema,
  selection: z.strictObject({
    kind: z.enum(["path", "query"]),
    query: z.string().nullable(),
    matches_considered: z.number().int().min(0),
  }),
  output_directory: z.string().min(1),
  copy: z.strictObject({
    root_kind: z.enum(["directory", "file"]),
    files: z.number().int().min(0),
    bytes: z.number().int().min(0),
    /** Digest over the copied files' paths and digests, from the extraction owner. */
    files_sha256: digestSchema.nullable(),
    extraction_id: z.string().nullable(),
  }),
  analysis_inputs: z.array(
    z.strictObject({
      operation: z.string().min(1),
      input_path: z.string().min(1),
    }),
  ),
  limitations: z.array(z.string()),
});
