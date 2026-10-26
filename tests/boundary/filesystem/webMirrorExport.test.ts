import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { exportWebMirror } from "../../../src/application/WebMirrorService.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { selectMirrorCapture } from "../../../src/browser/assets/MirrorCapture.js";
import { publishWebMirror } from "../../../src/browser/assets/PublishWebMirror.js";
import { PLAYWRIGHT_RESPONSE_BODY_PROVENANCE_LIMITATION } from "../../../src/domain/browserNetworkEvidence.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import {
  webMirrorExportResultSchema,
  webMirrorManifestSchema,
} from "../../../src/domain/webMirror.js";
import { webMirrorExportError } from "../../../src/domain/webScriptExportError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  webResourceScenarioFixture,
  type FixtureWebResource,
} from "../../fixtures/webScriptCapture.js";

const html = Buffer.from(
  `<!doctype html><link rel="stylesheet" href="/css/site.css?v=1" integrity="sha256-x"><img src="img/logo.png"><a href="next">next</a>`,
);
const css = Buffer.from(`body{background:url(../img/logo.png)}`);
const logo = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);

const site: readonly FixtureWebResource[] = [
  { url: "https://fixture.test/old", status: 301, resourceType: "document" },
  {
    url: "https://fixture.test/",
    bytes: html,
    resourceType: "document",
    mediaType: "text/html; charset=utf-8",
    redirectedFrom: "request-1",
  },
  {
    url: "https://fixture.test/css/site.css?v=1",
    bytes: css,
    resourceType: "stylesheet",
    mediaType: "text/css",
  },
  {
    url: "https://fixture.test/img/logo.png",
    bytes: logo,
    resourceType: "image",
    mediaType: "image/png",
  },
  {
    url: "https://fixture.test/missing.js",
    status: 200,
    resourceType: "script",
  },
];

const captureEvidence = (
  resources: readonly FixtureWebResource[] = site,
  entryUrl?: string,
) =>
  createEvidence(
    undefined,
    { id: "source-fixture", name: "Source fixture", version: "1" },
    {
      operation: "capture_browser_scenario",
      result: webResourceScenarioFixture(resources, entryUrl),
      parameters: {},
      confidence: "observed",
      authority: "controlled-replay",
    },
  );

const setup = async (capture: unknown = captureEvidence()) => {
  const root = await createTestTempDirectory("rea-web-mirror-export-");
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close());
  const input = {
    capture_path: join(root, "capture.json"),
    output_directory: join(root, "mirror"),
  };
  await writeFile(input.capture_path, JSON.stringify(capture));
  return { root, input, resources };
};

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

describe("export_web_mirror publication", () => {
  it("writes exact bytes, a rewritten view, an entry page and a manifest", async () => {
    const { input, resources } = await setup();
    const result = await exportWebMirror(input, resources);
    if (!result.ok) throw result.error;
    const value = webMirrorExportResultSchema.parse(
      result.value.normalized_result,
    );
    const out = input.output_directory;
    expect(value.entry).toEqual({
      url: "https://fixture.test/",
      file_path: "files/https_fixture.test_443/index.html",
      view_path: "view/https_fixture.test_443/index.html",
      open_path: "index.html",
    });
    expect(value.coverage).toEqual({
      transactions: 5,
      exported: 3,
      files: 3,
      redirects: 1,
      unavailable: 1,
      views: 2,
      rewritten_references: 3,
      unresolved_references: 1,
    });
    expect(value.unavailable).toEqual([
      {
        url: "https://fixture.test/missing.js",
        resource_type: "script",
        reason: "body-read-failed",
      },
    ]);
    expect(value.limitations).toContain(
      PLAYWRIGHT_RESPONSE_BODY_PROVENANCE_LIMITATION,
    );
    expect(result.value.evidence_links).toHaveLength(1);

    const cssPath = (
      await readdir(join(out, "files/https_fixture.test_443/css"))
    )[0];
    expect(cssPath).toMatch(/^site~q[0-9a-f]{12}\.css$/u);
    expect(
      (
        await readFile(join(out, "files/https_fixture.test_443/index.html"))
      ).equals(html),
    ).toBe(true);
    expect(
      (
        await readFile(join(out, "files/https_fixture.test_443/img/logo.png"))
      ).equals(logo),
    ).toBe(true);
    expect(
      await readFile(
        join(out, "view/https_fixture.test_443/index.html"),
        "utf8",
      ),
    ).toBe(
      `<!doctype html><link rel="stylesheet" href="css/${cssPath}" ><img src="../../files/https_fixture.test_443/img/logo.png"><a href="https://fixture.test/next">next</a>`,
    );
    expect(
      await readFile(
        join(out, `view/https_fixture.test_443/css/${cssPath}`),
        "utf8",
      ),
    ).toBe(
      `body{background:url("../../../files/https_fixture.test_443/img/logo.png")}`,
    );
    expect(await readFile(join(out, "index.html"), "utf8")).toContain(
      'url=view/https_fixture.test_443/index.html"',
    );

    const manifestBytes = await readFile(join(out, "manifest.json"));
    expect(sha256(manifestBytes)).toBe(value.manifest.sha256);
    const manifest = webMirrorManifestSchema.parse(
      JSON.parse(manifestBytes.toString("utf8")),
    );
    expect(manifest.resources.map(({ content }) => content.state)).toEqual([
      "redirect",
      "exported",
      "exported",
      "exported",
      "unavailable",
    ]);
    for (const { content } of manifest.resources)
      if (content.state === "exported")
        expect(sha256(await readFile(join(out, content.relative_path)))).toBe(
          content.sha256,
        );
  });

  it("rejects passive page inspections and keeps an existing destination", async () => {
    const { root, input, resources } = await setup({ completeness: {} });
    const malformed = await exportWebMirror(input, resources);
    if (malformed.ok) throw new Error("Expected a capture input failure");
    expect(malformed.error._tag).toBe("AnalysisInputError");
    expect(JSON.stringify(malformed.error)).toContain(
      "capture_browser_scenario",
    );

    await writeFile(input.capture_path, JSON.stringify(captureEvidence()));
    const marker = join(root, "mirror");
    await writeFile(marker, "keep");
    const existing = await exportWebMirror(input, resources);
    if (existing.ok) throw new Error("Expected exclusive output failure");
    expect(existing.error.userMessage).toContain("already exists");
    expect(await readFile(marker, "utf8")).toBe("keep");
  });
});

describe("export_web_mirror ownership", () => {
  it("rolls back owned output on integrity failure and on cancellation", async () => {
    const { root, input, resources } = await setup();
    const capture = selectMirrorCapture(captureEvidence());
    const broken = {
      ...capture,
      resources: capture.resources.map((resource) =>
        resource.content.state === "captured" &&
        resource.resource_type === "image"
          ? {
              ...resource,
              content: { ...resource.content, sha256: "0".repeat(64) },
            }
          : resource,
      ),
    };
    const error = webMirrorExportError("export_web_mirror");
    await expect(
      publishWebMirror(
        input.output_directory,
        broken,
        { path: input.capture_path, sha256: "a".repeat(64) },
        { operation: "export_web_mirror", resources, error },
      ),
    ).rejects.toMatchObject({ reason: "integrity" });
    expect(await readdir(root)).toEqual(["capture.json"]);

    const controller = new AbortController();
    controller.abort();
    await expect(
      publishWebMirror(
        input.output_directory,
        capture,
        { path: input.capture_path, sha256: "a".repeat(64) },
        {
          operation: "export_web_mirror",
          resources,
          error,
          signal: controller.signal,
        },
      ),
    ).rejects.toBeDefined();
    expect(await readdir(root)).toEqual(["capture.json"]);
  });

  it("persists the exact capture bytes when the clone path supplies them", async () => {
    const { root, resources } = await setup();
    const evidence = captureEvidence();
    const persisted = Buffer.from(JSON.stringify(evidence));
    const out = join(root, "clone");
    const result = await publishWebMirror(
      out,
      selectMirrorCapture(evidence),
      {
        path: "capture.json",
        sha256: sha256(persisted),
        persist: {
          bytes: persisted.byteLength,
          // Bounded parts, as a clone writes captures beyond V8's string limit.
          parts: () => [
            persisted.toString("utf8", 0, 7),
            persisted.toString("utf8", 7),
          ],
        },
      },
      {
        operation: "clone_website",
        resources,
        error: webMirrorExportError("clone_website"),
      },
    );
    expect(result.capture.path).toBe(join(out, "capture.json"));
    expect((await readFile(join(out, "capture.json"))).equals(persisted)).toBe(
      true,
    );
    expect(result.capture.source_evidence_id).toBe(evidence.evidence_id);
  });
});

describe("export_web_mirror view eligibility", () => {
  it("rewrites ASCII under a declared single-byte charset and keeps other bytes exact", async () => {
    const ascii = Buffer.from(`<img src="/img/logo.png">`);
    const latin = Buffer.from([
      ...Buffer.from(`<img src="/img/logo.png">`),
      0xe9,
    ]);
    const { input, resources } = await setup(
      captureEvidence([
        {
          url: "https://fixture.test/",
          bytes: ascii,
          resourceType: "document",
          mediaType: "text/html; charset=ISO-8859-1",
        },
        {
          url: "https://fixture.test/latin.html",
          bytes: latin,
          resourceType: "document",
          mediaType: "text/html; charset=windows-1252",
        },
        {
          url: "https://fixture.test/img/logo.png",
          bytes: logo,
          resourceType: "image",
          mediaType: "image/png",
        },
      ]),
    );
    const result = await exportWebMirror(input, resources);
    if (!result.ok) throw result.error;
    const value = webMirrorExportResultSchema.parse(
      result.value.normalized_result,
    );
    expect(value.coverage.views).toBe(1);
    expect(value.entry?.view_path).toBe(
      "view/https_fixture.test_443/index.html",
    );
    expect(value.limitations.join(" ")).toContain(
      "non-ASCII bytes under another declared charset",
    );
    expect(
      (
        await readFile(
          join(
            input.output_directory,
            "files/https_fixture.test_443/latin.html",
          ),
        )
      ).equals(latin),
    ).toBe(true);
  });
});

const exportResult = async (capture: unknown) => {
  const { input, resources } = await setup(capture);
  const result = await exportWebMirror(input, resources);
  if (!result.ok) throw result.error;
  return {
    input,
    value: webMirrorExportResultSchema.parse(result.value.normalized_result),
  };
};

const page = Buffer.from(`<!doctype html><p>page</p>`);

describe("export_web_mirror entry selection", () => {
  it("never opens a third-party frame when the start document is unavailable", async () => {
    const { value } = await exportResult(
      captureEvidence([
        { url: "https://fixture.test/", status: 200, resourceType: "document" },
        {
          url: "https://ads.example/frame.html",
          bytes: page,
          resourceType: "document",
          mediaType: "text/html",
        },
      ]),
    );
    expect(value.entry).toBeNull();
    expect(value.limitations).toContain(
      "No captured HTML document matched the start navigation, so no entry page was generated.",
    );
  });

  it("opens the start step's same-origin document after a client-side route change", async () => {
    const { value } = await exportResult(
      captureEvidence(
        [
          {
            url: "https://fixture.test/",
            bytes: page,
            resourceType: "document",
            mediaType: "text/html",
          },
        ],
        "https://fixture.test/app/home",
      ),
    );
    expect(value.entry?.url).toBe("https://fixture.test/");
    expect(value.limitations.join(" ")).toContain(
      "The start navigation ended at https://fixture.test/app/home, which matches no captured document",
    );
  });
});

describe("export_web_mirror resources without an absolute URL", () => {
  it("keeps their exact files and still mirrors the rest", async () => {
    const { value } = await exportResult(
      captureEvidence([
        {
          url: "https://fixture.test/",
          bytes: page,
          resourceType: "document",
          mediaType: "text/html",
        },
        {
          url: "inline-style",
          bytes: Buffer.from("a{b:url(c.png)}"),
          resourceType: "stylesheet",
          mediaType: "text/css",
        },
      ]),
    );
    expect(value.coverage).toMatchObject({ files: 2, views: 1 });
    expect(value.limitations.join(" ")).toContain(
      "have no absolute URL to resolve their references against",
    );
  });
});
