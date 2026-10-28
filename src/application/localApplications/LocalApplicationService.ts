import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, resolve } from "node:path";

import type { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { copyLocalApplication } from "../../artifacts/LocalApplicationCopy.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import {
  cloneLocalApplicationInputSchema,
  findLocalApplicationsInputSchema,
  LOCAL_APPLICATION_CANDIDATE_LIMIT,
  localApplicationCloneSchema,
  localApplicationDiscoverySchema,
  type CloneLocalApplicationInput,
  type FindLocalApplicationsInput,
  type LocalApplication,
} from "../../domain/localApplications.js";
import { err, ok, type Result } from "../../domain/result.js";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import { LOCAL_APPLICATION_PROVIDER as PROVIDER } from "../../domain/investigationProviders.js";
import {
  classifyApplicationPath,
  discoverLocalApplications,
  type LocalApplicationHost,
} from "./LocalApplicationDiscovery.js";

const FIND_OPERATION = "find_local_applications";
const CLONE_OPERATION = "clone_local_application";

/** The running host, as discovery sees it. */
export const currentLocalApplicationHost = (
  environment: Readonly<Record<string, string | undefined>>,
): LocalApplicationHost => ({
  platform: process.platform,
  environment,
  homeDirectory: homedir(),
});

/** Cancellation stays cancellation; anything else is an unexpected host failure. */
const unexpectedFailure = (
  operation: string,
  signal: AbortSignal | undefined,
  cause: unknown,
): AnalysisError =>
  signal?.aborted === true
    ? new AnalysisCancelledError(operation, { cause })
    : new ProviderAdapterError(PROVIDER.id, operation, {
        cause,
        diagnostics: {
          error_name: cause instanceof Error ? cause.name : "UnknownError",
          error_message: cause instanceof Error ? cause.message : String(cause),
        },
      });

/** Find installed applications by name through the shared CLI/MCP workflow. */
export const findLocalApplications = async (
  rawInput: unknown,
  host: LocalApplicationHost,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const parsed = findLocalApplicationsInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(
        FIND_OPERATION,
        parsed.error.issues,
        rawInput,
      ),
    );
  return findLocalApplicationsValidated(parsed.data, host, options);
};

/** Discovery input already parsed by a named adapter contract. */
export const findLocalApplicationsValidated = async (
  input: FindLocalApplicationsInput,
  host: LocalApplicationHost,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const roots = searchRootsError(FIND_OPERATION, input.search_roots);
  if (roots !== undefined) return err(roots);
  try {
    const discovery = localApplicationDiscoverySchema.parse(
      await discoverLocalApplications(
        input.query,
        input.search_roots,
        host,
        options.signal,
      ),
    );
    return ok(
      createEvidence(undefined, PROVIDER, {
        predicateType: "rea.local-application-discovery",
        operation: FIND_OPERATION,
        parameters: input,
        result: discovery,
        rawResult: null,
        confidence: "observed",
        authority: "shipped-artifact",
        subjectUnavailableReason:
          "Discovery searches application locations; each match names its own installed files.",
        limitations: discovery.limitations,
      }),
    );
  } catch (cause: unknown) {
    return err(unexpectedFailure(FIND_OPERATION, options.signal, cause));
  }
};

/** Dependencies of a copy: owned output resources and the child environment. */
export interface LocalApplicationCloneDependencies {
  readonly host: LocalApplicationHost;
  readonly resources: ArtifactResourceScope;
}

/** Copy one installed application, selected by path or by a unique name. */
export const cloneLocalApplication = async (
  rawInput: unknown,
  dependencies: LocalApplicationCloneDependencies,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const parsed = cloneLocalApplicationInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(
        CLONE_OPERATION,
        parsed.error.issues,
        rawInput,
      ),
    );
  return cloneLocalApplicationValidated(parsed.data, dependencies, options);
};

/** Clone input already parsed by a named adapter contract. */
export const cloneLocalApplicationValidated = async (
  input: CloneLocalApplicationInput,
  dependencies: LocalApplicationCloneDependencies,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  if (!isAbsolute(input.output_directory))
    return err(
      inputError(
        CLONE_OPERATION,
        ["output_directory"],
        "output_directory must be an absolute filesystem path on this host.",
      ),
    );
  const roots = searchRootsError(CLONE_OPERATION, input.search_roots);
  if (roots !== undefined) return err(roots);
  let selected: Result<SelectedApplication, AnalysisError>;
  try {
    selected = await selectApplication(
      input,
      dependencies.host,
      options.signal,
    );
  } catch (cause: unknown) {
    return err(unexpectedFailure(CLONE_OPERATION, options.signal, cause));
  }
  if (!selected.ok) return selected;
  const { application, considered, uniqueness } = selected.value;
  if (application.root_path === null || application.root_kind === null)
    return err(
      inputError(
        CLONE_OPERATION,
        ["application"],
        `The installed files of ${application.name} could not be resolved (${application.limitations.join(" ") || "no program path"}). Pass its install directory or executable as an absolute path.`,
      ),
    );
  const unsafe = unsafeCopy(
    application.root_path,
    input.output_directory,
    dependencies.host,
  );
  if (unsafe !== undefined)
    return err(inputError(CLONE_OPERATION, ["application"], unsafe));
  const copied = await copyLocalApplication(
    {
      root: application.root_path,
      rootKind: application.root_kind,
      outputDirectory: input.output_directory,
      environment: dependencies.host.environment,
      resources: dependencies.resources,
    },
    options.signal,
  );
  if (!copied.ok) return copied;
  const facts = copied.value;
  const root = application.root_path;
  const analysisInputs = application.electron_asar_paths.flatMap((path) => {
    const inside = relative(root, path);
    return inside.startsWith("..") || isAbsolute(inside)
      ? []
      : [
          {
            operation: "analyze_javascript_application",
            input_path: join(input.output_directory, inside),
          },
        ];
  });
  const clone = localApplicationCloneSchema.parse({
    application,
    selection: {
      kind: isAbsolute(input.application) ? "path" : "query",
      query: isAbsolute(input.application) ? null : input.application,
      matches_considered: considered,
    },
    output_directory: input.output_directory,
    copy: {
      root_kind: application.root_kind,
      files: facts.files,
      bytes: facts.bytes,
      files_sha256: facts.filesSha256,
      extraction_id: facts.extractionId,
    },
    analysis_inputs: analysisInputs,
    limitations: [
      ...application.limitations,
      ...(uniqueness === undefined ? [] : [uniqueness]),
      ...facts.limitations,
      "The copy reproduces the installed files only; it does not install, register or run the application, and settings, caches or data stored elsewhere are not included.",
    ],
  });
  return ok(
    createEvidence(undefined, PROVIDER, {
      predicateType: "rea.local-application-clone",
      operation: CLONE_OPERATION,
      parameters: input,
      result: clone,
      rawResult: null,
      confidence: "observed",
      authority: "shipped-artifact",
      subjectUnavailableReason:
        "An installed application is a file tree; copy.files_sha256 commits to the copied files.",
      limitations: clone.limitations,
      locations: [{ kind: "artifact-path", path: input.output_directory }],
    }),
  );
};

/** Selections a copy must never make, whatever their source. */
const unsafeCopy = (
  root: string,
  outputDirectory: string,
  host: LocalApplicationHost,
): string | undefined => {
  const resolvedRoot = resolve(root);
  if (resolvedRoot === parse(resolvedRoot).root)
    return `Refusing to copy a filesystem root (${root}); select the application's own directory.`;
  if (resolvedRoot === resolve(host.homeDirectory))
    return `Refusing to copy the home directory (${root}); select the application's own directory.`;
  const inside = relative(resolvedRoot, resolve(outputDirectory));
  if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside)))
    return `output_directory ${outputDirectory} is inside the application being copied (${root}); choose a directory outside it.`;
  return undefined;
};

/** Search roots name host directories; a relative one would follow the server's cwd. */
const searchRootsError = (
  operation: string,
  roots: readonly string[] | undefined,
): AnalysisInputError | undefined => {
  const relativeRoot = roots?.find((root) => !isAbsolute(root));
  return relativeRoot === undefined
    ? undefined
    : inputError(
        operation,
        ["search_roots"],
        `search_roots must be absolute filesystem paths; received ${relativeRoot}.`,
      );
};

const inputError = (
  operation: string,
  path: readonly string[],
  message: string,
): AnalysisInputError =>
  new AnalysisInputError(operation, undefined, [
    { path: [...path], reason: "invalid_value", message },
  ]);

interface SelectedApplication {
  readonly application: LocalApplication;
  readonly considered: number;
  /** Why a name's uniqueness could not be established, when it could not. */
  readonly uniqueness?: string;
}

/** Resolve the caller's selection to exactly one application. */
const selectApplication = async (
  input: CloneLocalApplicationInput,
  host: LocalApplicationHost,
  signal: AbortSignal | undefined,
): Promise<Result<SelectedApplication, AnalysisError>> => {
  if (isAbsolute(input.application)) {
    const candidate = await classifyApplicationPath(input.application, host);
    if (candidate === undefined)
      return err(
        inputError(
          CLONE_OPERATION,
          ["application"],
          `No application bundle, directory, desktop entry or regular file exists at ${input.application}.`,
        ),
      );
    const { names: _names, hidden: _hidden, ...application } = candidate;
    return ok({
      application: { ...application, matched_field: "path", exact: true },
      considered: 1,
    });
  }
  if (input.application.length < 2)
    return err(
      inputError(
        CLONE_OPERATION,
        ["application"],
        "A name to search for needs at least 2 characters.",
      ),
    );
  const discovery = await discoverLocalApplications(
    input.application,
    input.search_roots,
    host,
    signal,
  );
  const exact = discovery.matches.filter(({ exact }) => exact);
  const choice =
    exact.length === 1
      ? exact[0]
      : exact.length === 0 && discovery.matches.length === 1
        ? discovery.matches[0]
        : undefined;
  if (choice !== undefined)
    return ok({
      application: choice,
      considered: discovery.matches.length,
      // A location read only partly may hold another application of this name.
      ...(discovery.coverage.status === "partial"
        ? {
            uniqueness: `The name selected one application only among the locations read; ${discovery.coverage.reasons.join("; ")}. Another application with this name may be installed there; pass an absolute path to select it exactly.`,
          }
        : {}),
    });
  if (discovery.matches.length === 0)
    return err(
      inputError(
        CLONE_OPERATION,
        ["application"],
        `No installed application matches "${input.application}" in ${discovery.roots.filter(({ state }) => state !== "missing" && state !== "unreadable").length} searched location(s). Use find_local_applications to inspect the search, or pass the application's absolute path.`,
      ),
    );
  const pool = exact.length > 1 ? exact : discovery.matches;
  const listed = pool
    .slice(0, LOCAL_APPLICATION_CANDIDATE_LIMIT)
    .map(
      ({ name, kind, root_path, source_path }) =>
        `${name} [${kind}] ${root_path ?? source_path}`,
    );
  // Exact matches sort first, so an exact pool is never among the omitted.
  const total =
    exact.length > 1 ? exact.length : pool.length + discovery.matches_omitted;
  const omitted = total - listed.length;
  return err(
    inputError(
      CLONE_OPERATION,
      ["application"],
      `"${input.application}" matches ${total} ${exact.length > 1 ? "applications exactly" : "applications"}; pass one absolute path instead: ${listed.join("; ")}${omitted > 0 ? `; and ${omitted} more` : ""}.`,
    ),
  );
};
