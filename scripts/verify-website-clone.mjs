#!/usr/bin/env node
// Real-browser website clone verification through the public CLI and stdio MCP.
// Requires REA_BROWSER_EXECUTABLE (a Chrome-family executable) and a build.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { chromium } from "playwright-core";

const execFileAsync = promisify(execFile);
const executable = process.env.REA_BROWSER_EXECUTABLE;
if (executable === undefined || executable === "")
  throw new Error("Set REA_BROWSER_EXECUTABLE to a Chrome-family executable.");
const entrypoint = resolve(process.argv[2] ?? "scripts/rea.mjs");

const png = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8ffff3f0005fe02fe0dc3b2c30000000049454e44ae426082",
  "hex",
);
const SITE = {
  "/": [
    "text/html; charset=utf-8",
    `<!doctype html><html><head><base href="/"><link rel="stylesheet" href="css/site.css?v=3" integrity="sha256-x" crossorigin><script src="/js/app.js"></script></head><body><h1>Clone fixture</h1><img src="/img/logo.png"><a href="about">About</a></body></html>`,
  ],
  "/about": [
    "text/html",
    `<!doctype html><link rel="stylesheet" href="/css/site.css?v=3"><a href="/">home</a>`,
  ],
  "/css/site.css": [
    "text/css",
    `@import "base.css"; body { background: url(../img/logo.png) }`,
  ],
  "/css/base.css": ["text/css", "h1 { color: rgb(255, 0, 0) }"],
  "/js/app.js": ["text/javascript", "document.title = 'scripted';"],
  "/img/logo.png": ["image/png", png],
};

const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const entry = SITE[path];
  if (entry === undefined) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": entry[0] }).end(entry[1]);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const { port } = server.address();
const origin = `http://127.0.0.1:${port}`;
const work = await mkdtemp(join(tmpdir(), "rea-verify-website-clone-"));

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Check exact files against the persisted capture and open the view offline. */
const verifyClone = async (output, result) => {
  assert.equal(result.entry.url, `${origin}/`);
  assert.equal(result.coverage.unavailable, 0);
  assert.ok(result.coverage.views >= 3, "HTML and CSS views were written");
  const manifest = JSON.parse(await readFile(join(output, "manifest.json")));
  assert.equal(
    sha256(await readFile(join(output, "capture.json"))),
    manifest.capture.sha256,
  );
  for (const { content } of manifest.resources)
    if (content.state === "exported")
      assert.equal(
        sha256(await readFile(join(output, content.relative_path))),
        content.sha256,
        content.relative_path,
      );
  const browser = await chromium.launch({ executablePath: executable });
  try {
    const page = await browser.newPage();
    await page.goto(`file://${join(output, "index.html")}`);
    await page.waitForFunction(() => document.title === "scripted");
    const facts = await page.evaluate(() => ({
      color: getComputedStyle(document.querySelector("h1")).color,
      image: document.querySelector("img").naturalWidth,
      about: document.querySelector("a").getAttribute("href"),
    }));
    assert.deepEqual(facts, {
      color: "rgb(255, 0, 0)",
      image: 1,
      about: "about.html",
    });
  } finally {
    await browser.close();
  }
};

try {
  const cliOutput = join(work, "cli");
  const started = performance.now();
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      entrypoint,
      "clone-website",
      `${origin}/`,
      cliOutput,
      "--page",
      `${origin}/about`,
      "--format",
      "json",
    ],
    { env: { ...process.env, REA_LOG_LEVEL: "silent" }, maxBuffer: 64 << 20 },
  );
  const cliElapsed = Math.round(performance.now() - started);
  const cli = JSON.parse(stdout);
  assert.equal(cli.ok, true, stdout.slice(0, 2000));
  await verifyClone(cliOutput, cli.value.normalized_result);

  const client = new Client({
    name: "rea-website-clone-verifier",
    version: "1",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint, "mcp"],
    env: { ...process.env, REA_LOG_LEVEL: "silent" },
  });
  await client.connect(transport);
  let mcpElapsed;
  try {
    const mcpOutput = join(work, "mcp");
    const mcpStarted = performance.now();
    const reply = await client.callTool({
      name: "clone_website",
      arguments: {
        url: `${origin}/`,
        output_directory: mcpOutput,
        browser_executable_path: executable,
        additional_urls: [`${origin}/about`],
      },
    });
    mcpElapsed = Math.round(performance.now() - mcpStarted);
    assert.notEqual(reply.isError, true, JSON.stringify(reply.content));
    await verifyClone(mcpOutput, reply.structuredContent.normalized_result);
    process.stdout.write(
      `${JSON.stringify({ ok: true, cli_ms: cliElapsed, mcp_ms: mcpElapsed, mcp_reply_bytes: Buffer.byteLength(JSON.stringify(reply)) })}\n`,
    );
  } finally {
    await client.close();
  }
} finally {
  server.close();
  await rm(work, { recursive: true, force: true });
}
