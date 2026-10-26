import { resolve } from "node:path";

import { z } from "incur";
import type { Logger } from "pino";

import {
  cloneLocalApplication,
  currentLocalApplicationHost,
  findLocalApplications,
} from "../application/localApplications/LocalApplicationService.js";
import {
  cloneWebsite,
  exportWebMirror,
} from "../application/WebMirrorService.js";
import {
  LOCAL_APPLICATION_PROVIDER,
  WEB_MIRROR_EXPORT_PROVIDER,
} from "../domain/investigationProviders.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { cloneWebsiteInputSchema } from "../domain/webMirror.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import type { CliInstance } from "./types.js";

const cloneShape = cloneWebsiteInputSchema.shape;

// The CLI resolves relative paths against the caller's working directory;
// MCP keeps requiring absolute paths.
const absolute = (path: string): string => resolve(path);

const searchRootsOption = {
  searchRoot: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Directory to search instead of the platform's application locations; repeat for several",
    ),
};

/** Register website mirror/clone and local application clone commands. */
export const registerCloneCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  cli.command(CLI_COMMANDS.exportWebMirror, {
    description:
      "Mirror every response body retained in a saved browser scenario capture into an absent directory with a browsable view",
    args: z.object({
      capturePath: z
        .string()
        .describe("Path to saved capture-browser-scenario JSON"),
      outputDirectory: z
        .string()
        .describe(
          "Absent directory for exact files, the view and the manifest",
        ),
    }),
    run: ({ args }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.exportWebMirror, () => {
          const resources = new ArtifactResourceScope();
          return finishAnalysisCommand(
            () =>
              exportWebMirror(
                {
                  capture_path: absolute(args.capturePath),
                  output_directory: absolute(args.outputDirectory),
                },
                resources,
                { signal },
              ),
            resources,
            WEB_MIRROR_EXPORT_PROVIDER.id,
            "export_web_mirror",
            signal,
            "Website mirror resources",
          );
        }),
      ),
  });

  cli.command(CLI_COMMANDS.cloneWebsite, {
    description:
      "Clone a website page from its URL into an absent directory: load it in a selected browser, keep every response, and write a browsable copy",
    args: z.object({
      url: cloneShape.url,
      outputDirectory: z
        .string()
        .describe(
          "Absent directory for the capture, exact files, the view and the manifest",
        ),
    }),
    options: z.object({
      browser: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Chrome or Chromium-family executable; defaults to REA_BROWSER_EXECUTABLE",
        ),
      page: z
        .array(z.string().min(1))
        .optional()
        .describe("Another URL to visit after the first page; repeat in order"),
      settleMs: cloneShape.settle_ms,
      maxResourceBytes: cloneShape.max_resource_bytes,
      maxTotalBytes: cloneShape.max_total_bytes,
      maxResources: cloneShape.max_resources,
      headed: z
        .boolean()
        .default(false)
        .describe("Show the browser window instead of running headless"),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.cloneWebsite, async () => {
          // Load Playwright only for this command, not during CLI startup.
          const browser =
            await import("../composition/browserScenario.js").then(
              ({ createBrowserScenarioProvider }) =>
                createBrowserScenarioProvider(environment),
            );
          const resources = new ArtifactResourceScope();
          return finishAnalysisCommand(
            () =>
              cloneWebsite(
                {
                  url: args.url,
                  output_directory: absolute(args.outputDirectory),
                  ...(options.browser === undefined
                    ? {}
                    : { browser_executable_path: absolute(options.browser) }),
                  additional_urls: options.page ?? [],
                  settle_ms: options.settleMs,
                  max_resource_bytes: options.maxResourceBytes,
                  max_total_bytes: options.maxTotalBytes,
                  max_resources: options.maxResources,
                  headless: !options.headed,
                },
                { browser, resources, environment },
                { signal },
              ),
            {
              close: async () => {
                try {
                  await browser.close?.();
                } finally {
                  await resources.close();
                }
              },
            },
            WEB_MIRROR_EXPORT_PROVIDER.id,
            "clone_website",
            signal,
            "Website clone resources",
          );
        }),
      ),
  });

  cli.command(CLI_COMMANDS.findLocalApplications, {
    description:
      "Find applications installed on this computer by name, with their installed files and coverage",
    args: z.object({
      query: z
        .string()
        .describe("Application name, bundle identifier or directory name"),
    }),
    options: z.object(searchRootsOption),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.findLocalApplications, async () => {
          const result = await findLocalApplications(
            {
              query: args.query,
              ...(options.searchRoot === undefined
                ? {}
                : { search_roots: options.searchRoot.map(absolute) }),
            },
            currentLocalApplicationHost(environment),
            { signal },
          );
          return result.ok
            ? result.value
            : {
                error: "Application search failed",
                ...projectAnalysisError(result.error),
              };
        }),
      ),
  });

  cli.command(CLI_COMMANDS.cloneLocalApplication, {
    description:
      "Copy one installed application, selected by path or unique name, into an absent directory with verified digests",
    args: z.object({
      application: z
        .string()
        .describe(
          "Installed application path, or a name that matches exactly one application",
        ),
      outputDirectory: z
        .string()
        .describe("Absent directory for the verified copy"),
    }),
    options: z.object(searchRootsOption),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.cloneLocalApplication, () => {
          const resources = new ArtifactResourceScope();
          // Path syntax (a separator, or "." / "..") is resolved; anything
          // else is a name, including dot-prefixed names such as ".NET".
          const selection =
            /[/\\]/u.test(args.application) ||
            args.application === "." ||
            args.application === ".."
              ? absolute(args.application)
              : args.application;
          return finishAnalysisCommand(
            () =>
              cloneLocalApplication(
                {
                  application: selection,
                  output_directory: absolute(args.outputDirectory),
                  ...(options.searchRoot === undefined
                    ? {}
                    : { search_roots: options.searchRoot.map(absolute) }),
                },
                {
                  host: currentLocalApplicationHost(environment),
                  resources,
                },
                { signal },
              ),
            resources,
            LOCAL_APPLICATION_PROVIDER.id,
            "clone_local_application",
            signal,
            "Local application copy resources",
          );
        }),
      ),
  });
};
