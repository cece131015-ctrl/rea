import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import type { BrowserScenarioCapturePort } from "../../../src/application/BrowserScenarioCapturePort.js";
import { cloneWebsite } from "../../../src/application/WebMirrorService.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { webMirrorExportResultSchema } from "../../../src/domain/webMirror.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { webResourceScenarioFixture } from "../../fixtures/webScriptCapture.js";

const page = Buffer.from(`<!doctype html><img src="/logo.png">`);
const capture = () =>
  webResourceScenarioFixture([
    {
      url: "https://fixture.test/",
      bytes: page,
      resourceType: "document",
      mediaType: "text/html",
    },
    {
      url: "https://fixture.test/logo.png",
      bytes: Buffer.from([0x89, 0x50]),
      resourceType: "image",
      mediaType: "image/png",
    },
  ]);

/** A scenario port that records launches; `during` runs inside the capture. */
const fakeBrowser = (during: () => Promise<void> = async () => {}) => {
  const launches: unknown[] = [];
  const port: BrowserScenarioCapturePort = {
    identity: () => ({
      id: "fake-browser",
      name: "Fake browser",
      version: "1",
    }),
    captureScenario: async (scenario) => {
      launches.push(scenario);
      await during();
      return ok(capture());
    },
  };
  return { port, launches };
};

const setup = async () => {
  const root = await createTestTempDirectory("rea-website-clone-");
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close());
  return { root, resources };
};

const input = (output_directory: string) => ({
  url: "https://fixture.test/",
  output_directory,
  browser_executable_path: "/opt/chromium/chrome",
});

describe("clone_website", () => {
  it("persists the capture it mirrors with the digest it reports", async () => {
    const { root, resources } = await setup();
    const { port } = fakeBrowser();
    const output = join(root, "clone");
    const result = await cloneWebsite(input(output), {
      browser: port,
      resources,
      environment: {},
    });
    if (!result.ok) throw result.error;
    const value = webMirrorExportResultSchema.parse(
      result.value.normalized_result,
    );
    const persisted = await readFile(join(output, "capture.json"));
    expect(createHash("sha256").update(persisted).digest("hex")).toBe(
      value.capture.sha256,
    );
    const evidence = parseEvidence(JSON.parse(persisted.toString("utf8")));
    expect(result.value.evidence_links).toEqual([evidence.evidence_id]);
    expect(value.coverage).toMatchObject({ files: 2, views: 1 });
  });

  it("refuses an unusable destination before launching the browser", async () => {
    const { root, resources } = await setup();
    const { port, launches } = fakeBrowser();
    await mkdir(join(root, "taken"));
    for (const output of [join(root, "taken"), join(root, "no", "parent")]) {
      const result = await cloneWebsite(input(output), {
        browser: port,
        resources,
        environment: {},
      });
      if (result.ok) throw new Error(`Expected ${output} to be refused`);
      expect(result.error).toMatchObject({
        _tag: "AnalysisInputError",
        operation: "clone_website",
      });
    }
    expect(launches).toHaveLength(0);
  });

  it("names clone_website when no browser provider is configured", async () => {
    const { root, resources } = await setup();
    const result = await cloneWebsite(input(join(root, "clone")), {
      browser: undefined,
      resources,
      environment: {},
    });
    if (result.ok) throw new Error("Expected an unavailable provider");
    expect(result.error).toMatchObject({
      _tag: "AnalysisCapabilityUnavailableError",
      operation: "clone_website",
    });
  });

  it("keeps the completed capture when its mirror cannot be published", async () => {
    const { root, resources } = await setup();
    const output = join(root, "raced");
    // Another writer takes the destination while the page loads.
    const { port } = fakeBrowser(() => mkdir(output));
    const result = await cloneWebsite(input(output), {
      browser: port,
      resources,
      environment: {},
    });
    if (result.ok) throw new Error("Expected the publication to fail");
    expect(parseEvidence(result.error.partialObservation).operation).toBe(
      "capture_browser_scenario",
    );
    expect(await readdir(output)).toEqual([]);
  });
});
