import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
// A developer verifier: the caller selects the pinned TodoMVC distribution,
// browser executable, output directory and baseline/final repository checkout.
const { values } = parseArgs({
  options: {
    repository: {
      type: "string",
      default: fileURLToPath(new URL("../../", import.meta.url)),
    },
    mode: { type: "string", default: "summary" },
    application: { type: "string" },
    browser: { type: "string" },
    output: { type: "string" },
    port: { type: "string", default: "0" },
    "verify-boundaries": { type: "boolean", default: false },
  },
});
assert.ok(
  values.application && values.browser && values.output,
  "Pass --application <TodoMVC javascript-es5 dist> --browser <executable> --output <new directory>",
);
const repo = resolve(values.repository);
const mode = values.mode;
const output = resolve(values.output);
const appRoot = resolve(values.application);
const executablePath = resolve(values.browser);
assert.ok(["complete", "summary"].includes(mode));
assert.ok(
  !values["verify-boundaries"] || mode === "summary",
  "--verify-boundaries requires summary mode",
);
process.chdir(repo);
const require = createRequire(join(repo, "package.json"));
const { Client } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/client")).href
);
const { StdioClientTransport } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/client/stdio")).href
);
await mkdir(output);
const files = await readdir(appRoot);
const server = createServer(async (request, response) => {
  try {
    const name =
      decodeURIComponent(
        new URL(request.url, "http://127.0.0.1").pathname,
      ).slice(1) || "index.html";
    assert.ok(files.includes(name));
    const data = await readFile(join(appRoot, name));
    response.setHeader(
      "Content-Type",
      { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[
        extname(name)
      ] ?? "application/octet-stream",
    );
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((done, reject) => {
  server.once("error", reject);
  server.listen(Number(values.port), "127.0.0.1", done);
});
const address = server.address();
assert.ok(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;
const environment = {
  PATH: process.env.PATH,
  NODE_OPTIONS: "--max-old-space-size=3072",
  UV_THREADPOOL_SIZE: "2",
  REA_LOG_LEVEL: "silent",
  REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
};
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(repo, "scripts/rea.mjs"), "mcp"],
  cwd: repo,
  env: environment,
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (chunk) => {
  if (stderr.length < 65536) stderr += chunk;
});
const client = new Client({
  name: "rea-browser-scenario-summary-verifier",
  version: "1",
});
const calls = [];
const invoke = async (name, args, tools) => {
  const toolDefinition = tools.find((tool) => tool.name === name);
  assert.ok(
    toolDefinition?.outputSchema,
    `Missing named output schema: ${name}`,
  );
  const started = performance.now();
  const result = await client.callTool(
    { name, arguments: args },
    { toolDefinition, timeout: 90000 },
  );
  calls.push({
    name,
    arguments: args,
    content: result.content,
    elapsed_ms: performance.now() - started,
  });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return result.structuredContent;
};
const allStarted = performance.now();
try {
  await client.connect(transport);
  const discoveryStarted = performance.now();
  const catalog = await client.listTools();
  const discoveryMs = performance.now() - discoveryStarted;
  await writeFile(join(output, "catalog.json"), JSON.stringify(catalog));
  const actions = Array.from({ length: 5 }, (_, index) => [
    {
      step_id: `fill_${index}`,
      action: "fill",
      locator: { kind: "css", selector: ".new-todo" },
      value: { source: "literal", value: `Review evidence ${index + 1}` },
      timeout_ms: 10000,
    },
    {
      step_id: `add_${index}`,
      action: "press",
      locator: { kind: "css", selector: ".new-todo" },
      key: "Enter",
      timeout_ms: 10000,
    },
  ]).flat();
  const scenario = {
    browser: {
      mode: "launch",
      executable_path: executablePath,
      headless: true,
    },
    start_url: { url: origin, query: [] },
    actions,
    capture: {
      after_each_step: ["url", "dom", "accessibility", "screenshot"],
      at_end: ["url", "dom", "accessibility"],
      events: ["network"],
    },
  };
  const runs = [];
  for (const temperature of ["cold", "warm"]) {
    const callStart = calls.length;
    const result = await invoke(
      "capture_browser_scenario",
      { ...scenario, ...(mode === "summary" ? { detail: "summary" } : {}) },
      catalog.tools,
    );
    const parentId =
      mode === "summary"
        ? result.normalized_result.parent_evidence_id
        : result.evidence_id;
    const bundlePath = join(output, `${temperature}-evidence.json`);
    await invoke("export_evidence_bundle", { path: bundlePath }, catalog.tools);
    const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
    const parent = bundle.records.find((row) => row.evidence_id === parentId);
    assert.ok(parent);
    const capture = parent.normalized_result;
    assert.equal(capture.steps.length, 11);
    assert.ok(capture.steps.every((step) => step.status === "completed"));
    assert.equal(capture.browser.cleanup, "terminated-owned-process");
    const final = capture.steps.at(-1).artifacts.accessibility;
    assert.equal(final.state, "captured");
    for (let index = 1; index <= 5; index++)
      assert.ok(final.value.text.includes(`Review evidence ${index}`));
    assert.ok(final.value.text.includes('strong: "5"'));
    assert.ok(final.value.text.includes("text: items left"));
    const transactionIds = new Set(
      capture.events.items
        .filter((event) => "transaction_id" in event)
        .map((event) => event.transaction_id),
    );
    const details = {
      temperature,
      parentId,
      steps: capture.steps.length,
      retained_events: capture.events.retained,
      transactions: transactionIds.size,
    };
    if (mode === "summary") {
      const summary = result.normalized_result.summary;
      assert.equal(summary.steps.length, 11);
      assert.equal(
        summary.final_accessibility.accessibility.value.text,
        final.value.text,
      );
      assert.equal(summary.events.retained, capture.events.retained);
      assert.equal(summary.limitation_count, parent.limitations.length);
      assert.equal(summary.network.transactions, transactionIds.size);
      const source = { kind: "retained-evidence", evidence_id: parentId };
      const pagingStarted = performance.now();
      for (const stepIndex of [1, 5, 10]) {
        const page = await invoke(
          "inspect_analysis_view",
          {
            source,
            view: {
              kind: "browser-scenario",
              collection: "steps",
              step_indices: [stepIndex],
              artifacts: [],
              limit: 1,
            },
          },
          catalog.tools,
        );
        assert.equal(
          page.normalized_result.items.rows[0].step_id,
          capture.steps[stepIndex].step_id,
        );
      }
      details.warm_page_total_ms = performance.now() - pagingStarted;
      const text = await invoke(
        "inspect_analysis_view",
        {
          source,
          view: {
            kind: "browser-scenario",
            collection: "text",
            step_index: 10,
            artifact: "accessibility",
            offset: 0,
            limit: 32,
          },
        },
        catalog.tools,
      );
      assert.equal(
        text.normalized_result.items.text,
        final.value.text.slice(0, 32),
      );
      const tx = await invoke(
        "inspect_analysis_view",
        {
          source,
          view: {
            kind: "browser-scenario",
            collection: "transactions",
            limit: 2,
          },
        },
        catalog.tools,
      );
      assert.deepEqual(
        tx.normalized_result.items.rows.map((row) => row.transaction_id),
        [...transactionIds].slice(0, 2),
      );
      details.returned_summary = summary;
    }
    details.calls = calls.slice(callStart);
    runs.push(details);
  }
  const boundaryChecks = [];
  if (values["verify-boundaries"]) {
    const failed = await invoke(
      "capture_browser_scenario",
      {
        ...scenario,
        actions: [
          {
            step_id: "missing",
            action: "click",
            locator: {
              kind: "css",
              selector: "#rea-control-that-does-not-exist",
            },
            timeout_ms: 100,
          },
        ],
        capture: {
          after_each_step: ["url", "accessibility"],
          at_end: ["url", "accessibility"],
          events: ["network"],
        },
        detail: "summary",
      },
      catalog.tools,
    );
    assert.equal(failed.normalized_result.summary.steps[1].status, "failed");
    assert.equal(
      failed.normalized_result.summary.final_accessibility.focus_step_index,
      1,
    );
    assert.equal(
      failed.normalized_result.summary.completeness.equality_eligible,
      false,
    );
    boundaryChecks.push("real failed-step focus and incomplete coverage");
    const execute = promisify(execFile);
    const bundlePath = join(output, "cli-evidence.json");
    const { stdout } = await execute(
      process.execPath,
      [
        join(repo, "scripts/rea.mjs"),
        "capture-browser-scenario",
        JSON.stringify(scenario),
        "--detail",
        "summary",
        "--evidence_output",
        bundlePath,
        "--json",
      ],
      {
        cwd: repo,
        env: environment,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 90000,
      },
    );
    const cli = JSON.parse(stdout);
    const parentId = cli.summary.normalized_result.parent_evidence_id;
    const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
    const parent = bundle.records.find((row) => row.evidence_id === parentId);
    assert.ok(parent);
    assert.equal(parent.normalized_result.steps.length, 11);
    assert.ok(
      parent.normalized_result.steps.every(
        (step) => step.status === "completed",
      ),
    );
    assert.ok(!("detail" in parent.parameters));
    assert.equal(
      cli.summary.normalized_result.summary.final_accessibility.accessibility
        .value.text,
      parent.normalized_result.steps.at(-1).artifacts.accessibility.value.text,
    );
    const text = await invoke(
      "inspect_analysis_view",
      {
        source: {
          kind: "evidence-file",
          path: bundlePath,
          evidence_id: parentId,
        },
        view: {
          kind: "browser-scenario",
          collection: "text",
          step_index: 10,
          artifact: "accessibility",
          offset: 0,
          limit: 32,
        },
      },
      catalog.tools,
    );
    assert.equal(
      text.normalized_result.items.text,
      parent.normalized_result.steps
        .at(-1)
        .artifacts.accessibility.value.text.slice(0, 32),
    );
    boundaryChecks.push(
      "real CLI summary, complete bundle and MCP evidence-file readback",
    );
  }
  await writeFile(
    join(output, "result.json"),
    JSON.stringify(
      {
        repo,
        mode,
        application: appRoot,
        browser: executablePath,
        input_paths: {
          repository: values.repository,
          application: values.application,
          browser: values.browser,
          output: values.output,
        },
        origin,
        discovery_ms: discoveryMs,
        elapsed_ms: performance.now() - allStarted,
        runs,
        boundaryChecks,
        stderr,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      mode,
      discovery_ms: discoveryMs,
      runs: runs.map(
        ({ calls: _calls, returned_summary: _summary, ...rest }) => rest,
      ),
      boundaryChecks,
      elapsed_ms: performance.now() - allStarted,
    }),
  );
} finally {
  await client.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
