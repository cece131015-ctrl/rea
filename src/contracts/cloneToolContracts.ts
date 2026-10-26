import {
  cloneLocalApplicationInputSchema,
  findLocalApplicationsInputSchema,
  localApplicationCloneSchema,
  localApplicationDiscoverySchema,
} from "../domain/localApplications.js";
import {
  cloneWebsiteInputSchema,
  exportWebMirrorInputSchema,
  webMirrorExportResultSchema,
} from "../domain/webMirror.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";

/** Website mirror contracts over saved captures, shared by CLI and MCP. */
export const WEB_MIRROR_EXPORT_TOOL_CONTRACTS = [
  {
    name: "export_web_mirror",
    ...toolContractMetadata("export_web_mirror"),
    description:
      "Mirror every response body retained in one saved capture_browser_scenario JSON (normalized result or complete Evidence, captured with capture.network.response_body) into an absent absolute output_directory. files/ keeps the exact bytes of every captured resource, verified against the capture digests; view/ holds UTF-8 HTML and CSS copies whose captured references point to local relative paths; index.html opens the entry page. Returns the entry document, coverage counts, unavailable resources and the manifest digest; per-resource records stay in manifest.json. Nothing is refetched and JavaScript is never rewritten.",
    kind: "application",
    inputSchema: exportWebMirrorInputSchema,
    outputSchema: evidenceResultOf(webMirrorExportResultSchema),
    examples: [
      {
        title: "Mirror a saved scenario capture into a browsable local copy",
        input: {
          capture_path: "/analysis/scenario-capture.json",
          output_directory: "/analysis/site-mirror",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];

/** Live website clone contracts; they run the caller-selected browser. */
export const WEBSITE_CLONE_TOOL_CONTRACTS = [
  {
    name: "clone_website",
    ...toolContractMetadata("clone_website"),
    description:
      "Clone a website page from its URL into an absent absolute output_directory: launches the caller-selected Chrome or Chromium-family browser (browser_executable_path or REA_BROWSER_EXECUTABLE), loads the page and optional additional_urls with their JavaScript running, retains every response body within the selected byte budgets, saves the capture Evidence as capture.json, and writes the same exact files, browsable view and manifest as export_web_mirror. The page can contact any server while it loads. Returns the entry document, coverage counts, unavailable resources and the manifest digest.",
    kind: "browser-provider",
    inputSchema: cloneWebsiteInputSchema,
    outputSchema: evidenceResultOf(webMirrorExportResultSchema),
    examples: [
      {
        title: "Clone one page with a selected Chromium executable",
        input: {
          url: "https://example.com/",
          output_directory: "/analysis/example-clone",
          browser_executable_path: "/opt/chromium/chrome",
        },
      },
      {
        title: "Clone a page and two linked pages in one session",
        input: {
          url: "https://example.com/",
          output_directory: "/analysis/example-site",
          additional_urls: [
            "https://example.com/about",
            "https://example.com/contact",
          ],
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];

/** Local installed-application discovery and copy contracts. */
export const LOCAL_APPLICATION_TOOL_CONTRACTS = [
  {
    name: "find_local_applications",
    ...toolContractMetadata("find_local_applications"),
    description:
      "Find applications installed on this computer by name. Searches the platform's application locations (macOS app bundles, Linux desktop entries, /opt and AppImages, Windows program directories) or caller-selected search_roots, matching bundle names, identifiers, desktop entry names and directory names case-insensitively. Returns each match's installed files root, program path when resolved, Electron app.asar archives, the matched field, and per-location coverage. Reads metadata only.",
    kind: "application",
    inputSchema: findLocalApplicationsInputSchema,
    outputSchema: evidenceResultOf(localApplicationDiscoverySchema),
    examples: [
      {
        title: "Find an installed application by name",
        input: { query: "Visual Studio Code" },
      },
      {
        title: "Search one directory of portable applications",
        input: { query: "editor", search_roots: ["/opt/tools"] },
      },
    ],
  },
  {
    name: "clone_local_application",
    ...toolContractMetadata("clone_local_application"),
    description:
      "Copy one application installed on this computer into an absent absolute output_directory, selected by absolute path or by a name that matches exactly one application (otherwise the candidates are listed). Directories are copied as regular files without following symbolic links, each write verified by SHA-256 and rolled back on failure. Returns the selected application, copied file count, bytes and file-set digest, and analysis inputs such as Electron app.asar archives for analyze_javascript_application. The copied application is never started.",
    kind: "application",
    inputSchema: cloneLocalApplicationInputSchema,
    outputSchema: evidenceResultOf(localApplicationCloneSchema),
    examples: [
      {
        title: "Copy an installed application by name",
        input: {
          application: "LibreOffice",
          output_directory: "/analysis/libreoffice-copy",
        },
      },
      {
        title: "Copy an application bundle by path",
        input: {
          application: "/Applications/Example.app",
          output_directory: "/analysis/example-app",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
