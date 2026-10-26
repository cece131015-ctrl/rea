/** Equivalent real Ghidra investigations, including every page and complete source context. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { finished } from "node:stream/promises";
import { parseArgs, promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createRetainedQueryCaller } from "./retained-query-calls.mjs";
import { finalizeRetainedQueryReceipt } from "./retained-query-finalization.mjs";
const { values } = parseArgs({
  options: Object.fromEntries(
    ["runtime", "target", "output", "ghidra", "java", "mode", "control"].map(
      (name) => [name, { type: "string" }],
    ),
  ),
});
for (const key of ["runtime", "target", "output", "ghidra", "java"]) {
  assert.ok(values[key], `Missing --${key}`);
  values[key] = resolve(values[key]);
}
assert.ok(["complete", "summary"].includes(values.mode));
await mkdir(values.output);
const load = (path) => import(pathToFileURL(join(values.runtime, path)).href);
let parseEvidence, evidenceSubjectIdentity, digestCanonicalValue;
const hash = (value) => createHash("sha256").update(value).digest("hex");
let account, transport, serverLog, serverLogFinished, client, call;
const git = async (args) =>
  (await promisify(execFile)("git", ["-C", values.runtime, ...args])).stdout;
const report = {
  mode: values.mode,
  runtime: values.runtime,
  revision: null,
  dirty: null,
  target: values.target,
  sha256: null,
  question:
    "Resolve 21 recorded functions, retain all caller/callee facts and two graphs, materialize every source profile and caveat, and inspect one unknown-symbol error, twice in one session.",
  calls: [],
  runs: [],
};
const transcript = [];
const good = async (name, input, phase) => {
  const reply = await call(name, input, phase);
  assert.notEqual(reply.isError, true, JSON.stringify(reply));
  return parseEvidence(reply.structuredContent);
};
const page = async (id, view, phase) =>
  (
    await good(
      "inspect_analysis_view",
      { source: { kind: "retained-evidence", evidence_id: id }, view },
      phase,
    )
  ).normalized_result;
const contexts = new Map(),
  profiles = new Map(),
  expectedParents = new Map();
const readContext = async (summary, phase) => {
  const ref = summary.source_context;
  if (contexts.has(ref.digest)) return contexts.get(ref.digest);
  const id = summary.parent_evidence_id;
  const facet = async (name) => {
    let offset = 0,
      rows = [];
    while (true) {
      const result = await page(
        id,
        { kind: "native-context", facet: name, offset, limit: 512 },
        `${phase}:context:${name}`,
      );
      assert.equal(result.source_context.digest, ref.digest);
      if (result.items.rows === null) return null;
      for (const row of result.items.rows) {
        assert.equal(row.source_index, rows.length);
        rows.push(
          name === "limitations" || name === "result-limitations"
            ? row.text
            : row.record,
        );
      }
      if (result.coverage.exhausted) return rows;
      assert.ok(result.coverage.next_offset > offset);
      offset = result.coverage.next_offset;
    }
  };
  const overview = (await facet("overview"))[0];
  const profileId = overview.analysis_profile_digest;
  if (!profiles.has(profileId))
    profiles.set(profileId, (await facet("analysis-profile"))[0]);
  const { analysis_profile_digest: _digest, ...metadata } = overview;
  const context = {
    ...metadata,
    analysis_profile: profiles.get(profileId),
    limitations: await facet("limitations"),
    result_limitations: await facet("result-limitations"),
  };
  assert.equal(context.limitations.length, ref.evidence_limitation_count);
  assert.equal(
    context.result_limitations?.length ?? null,
    ref.result_limitation_count,
  );
  assert.equal(
    digestCanonicalValue(
      { ...context, subject: evidenceSubjectIdentity(context.subject) },
      "Native source context",
    ),
    ref.digest,
  );
  contexts.set(ref.digest, context);
  return context;
};
const decodeGraphRow = (row, messages) => {
  if (row.status === "empty-level") return null;
  const { level: _level, source_index: _index, ...node } = row;
  if (row.status === "error") return node;
  const { limitation_ids, relationship_coverage: coverage, ...rest } = node;
  const {
    diagnostic_ids,
    limitation_ids: coverageIds,
    reason_id,
    ...coverageRest
  } = coverage;
  return {
    ...rest,
    ...(limitation_ids === undefined
      ? {}
      : { limitations: limitation_ids.map((id) => messages[id]) }),
    relationship_coverage: {
      ...coverageRest,
      ...(diagnostic_ids === undefined
        ? {}
        : { diagnostics: diagnostic_ids.map((id) => messages[id]) }),
      ...(coverageIds === undefined
        ? {}
        : { limitations: coverageIds.map((id) => messages[id]) }),
      ...(reason_id === undefined ? {} : { reason: messages[reason_id] }),
    },
  };
};
const observation = async (name, args, phase) => {
  const evidence = await good(
    name,
    { ...args, ...(values.mode === "summary" ? { detail: "summary" } : {}) },
    phase,
  );
  if (values.mode === "complete") {
    expectedParents.set(evidence.evidence_id, {
      result: evidence.normalized_result,
    });
    return evidence;
  }
  const summary = evidence.normalized_result,
    id = summary.parent_evidence_id;
  const context = await readContext(summary, phase);
  let selected = summary,
    received = 0;
  const rows = [],
    graph = {};
  while (true) {
    for (const row of selected.items.rows) {
      if (name === "get_call_graph") {
        const nodes = (graph[row.level] ??= []);
        const node = decodeGraphRow(row, selected.items.messages);
        if (node !== null) {
          assert.equal(row.source_index, nodes.length);
          nodes.push(node);
        }
      } else {
        assert.equal(row.source_index, rows.length);
        rows.push(
          selected.items.type === "resolutions" ? row.record : row.address,
        );
      }
      received++;
    }
    if (selected.coverage.exhausted) break;
    assert.equal(selected.coverage.next_offset, received);
    selected = await page(
      id,
      { kind: "native-observation", offset: received, limit: 512 },
      `${phase}:facts-page`,
    );
    assert.equal(selected.source_context.digest, summary.source_context.digest);
  }
  assert.equal(received, summary.summary.observations);
  const result =
    name === "get_call_graph"
      ? { graph, limitations: context.result_limitations }
      : name === "resolve_containing_procedure" || name === "procedure_address"
        ? rows[0]
        : rows;
  expectedParents.set(id, { result, context });
  return { evidence_id: id, normalized_result: result };
};
let opened = false;
const started = performance.now();
try {
  ({ parseEvidence, evidenceSubjectIdentity } = await load(
    "dist/domain/evidence.js",
  ));
  ({ digestCanonicalValue } = await load("dist/domain/canonicalDigest.js"));
  report.revision = (await git(["rev-parse", "HEAD"])).trim();
  report.dirty = (await git(["status", "--porcelain"])).length > 0;
  report.sha256 = hash(await readFile(values.target));
  account = await mkdtemp(join(tmpdir(), "rea-native-observations-"));
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(values.runtime, "scripts/rea.mjs"), "mcp"],
    cwd: values.runtime,
    env: {
      HOME: account,
      PATH: process.env.PATH,
      NODE_OPTIONS: "--max-old-space-size=3072",
      GHIDRA_INSTALL_DIR: values.ghidra,
      JAVA_HOME: values.java,
      GHIDRA_HEADLESS_MAXMEM: "1536M",
      REA_GHIDRA_STARTUP_TIMEOUT_MS: "600000",
      REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
      REA_LOG_LEVEL: "silent",
    },
    stderr: "pipe",
  });
  serverLog = createWriteStream(join(values.output, "server.log"));
  serverLogFinished = finished(serverLog);
  serverLogFinished.catch(() => {});
  transport.stderr?.pipe(serverLog);
  client = new Client({ name: "native-observation-views", version: "1" });
  call = createRetainedQueryCaller(client, (receipt, event) => {
    report.calls.push(receipt);
    transcript.push(event);
  });
  await client.connect(transport);
  const catalog = await client.listTools();
  assert.equal(catalog.nextCursor, undefined);
  await writeFile(join(values.output, "catalog.json"), JSON.stringify(catalog));
  const definitions = new Map(catalog.tools.map((tool) => [tool.name, tool]));
  const original = client.callTool.bind(client);
  client.callTool = (input, options) =>
    original(input, {
      ...options,
      timeout: 600000,
      toolDefinition: definitions.get(input.name),
    });
  const open = await call(
    "open_binary",
    { path: values.target, provider_id: "ghidra" },
    "open",
  );
  assert.notEqual(open.isError, true, JSON.stringify(open));
  opened = true;
  let seeds;
  for (const phase of ["cold", "warm"]) {
    const start = performance.now();
    const inventory = await good("list_procedures", {}, `${phase}:inventory`);
    const rows = inventory.normalized_result;
    assert.ok(Array.isArray(rows));
    seeds ??= rows
      .filter((row) => !row.procedure?.external && !row.procedure?.thunk)
      .slice(0, 21)
      .map((row) => row.address);
    assert.equal(seeds.length, 21);
    const ids = [],
      facts = [];
    let mostCallers = { address: seeds[0], count: -1 },
      mostCallees = { address: seeds[0], count: -1 };
    for (const address of seeds) {
      for (const [name, args] of [
        ["procedure_callees", { procedure: address }],
        ["procedure_callers", { procedure: address }],
        ["resolve_containing_procedure", { address }],
      ]) {
        const evidence = await observation(name, args, `${phase}:${name}`);
        ids.push(evidence.evidence_id);
        facts.push(evidence.normalized_result);
        if (
          name === "procedure_callees" &&
          evidence.normalized_result.length > mostCallees.count
        )
          mostCallees = { address, count: evidence.normalized_result.length };
        if (
          name === "procedure_callers" &&
          evidence.normalized_result.length > mostCallers.count
        )
          mostCallers = { address, count: evidence.normalized_result.length };
      }
    }
    for (const direction of ["forward", "backward"]) {
      const evidence = await observation(
        "get_call_graph",
        {
          address:
            direction === "forward" ? mostCallees.address : mostCallers.address,
          direction,
        },
        `${phase}:graph:${direction}`,
      );
      ids.push(evidence.evidence_id);
      facts.push(evidence.normalized_result);
    }
    const missing = await call(
      "procedure_callers",
      {
        procedure: "rea_unknown_symbol_6426",
        ...(values.mode === "summary" ? { detail: "summary" } : {}),
      },
      `${phase}:missing`,
    );
    assert.equal(missing.isError, true);
    const error = JSON.parse(
      missing.content.find((item) => item.type === "text").text,
    ).error;
    assert.equal(error.code, "invalid_request");
    assert.equal(error.retryable, false);
    assert.equal(error.details.diagnostics.diagnostic_scope, "request");
    assert.equal(error.details.diagnostics.target_sha256, report.sha256);
    const run = {
      phase,
      inventory_count: rows.length,
      seeds,
      mostCallers,
      mostCallees,
      success_evidence_ids: ids,
      facts_sha256: digestCanonicalValue(facts, "Investigation facts"),
      elapsed_ms: performance.now() - start,
    };
    await writeFile(
      join(values.output, `${phase}-facts.json`),
      JSON.stringify(facts),
    );
    if (values.control) {
      assert.deepEqual(
        facts,
        JSON.parse(
          await readFile(join(values.control, `${phase}-facts.json`), "utf8"),
        ),
      );
      const control = JSON.parse(
        await readFile(join(values.control, "report.json"), "utf8"),
      );
      assert.deepEqual(
        ids,
        control.runs.find((item) => item.phase === phase).success_evidence_ids,
      );
    }
    report.runs.push(run);
  }
  const exported = await call(
    "export_evidence_bundle",
    { path: join(values.output, "complete-evidence.json") },
    "export",
  );
  assert.notEqual(exported.isError, true, JSON.stringify(exported));
  const bundle = JSON.parse(
    await readFile(join(values.output, "complete-evidence.json"), "utf8"),
  );
  for (const [id, expected] of expectedParents) {
    const evidence = parseEvidence(
      bundle.records.find((record) => record.evidence_id === id),
    );
    assert.equal(evidence.subject.digest.sha256, report.sha256);
    assert.deepEqual(evidence.normalized_result, expected.result);
    if (expected.context)
      assert.deepEqual(expected.context, {
        subject: evidence.subject,
        provider: evidence.provider,
        analysis_profile: evidence.analysis_profile,
        authority: evidence.authority,
        environment: evidence.environment,
        limitations: evidence.limitations,
        result_limitations:
          evidence.operation === "get_call_graph"
            ? evidence.normalized_result.limitations
            : null,
      });
  }
  report.verified_parent_count = expectedParents.size;
  report.materialized_contexts = contexts.size;
  report.materialized_profiles = profiles.size;
  const close = await call("close_binary", {}, "close");
  assert.notEqual(close.isError, true, JSON.stringify(close));
  opened = false;
  assert.equal(hash(await readFile(values.target)), report.sha256);
  report.status = "passed";
} catch (cause) {
  report.status = "failed";
  report.failure = String(cause?.stack ?? cause);
  process.exitCode = 1;
} finally {
  if (opened)
    try {
      const close = await call("close_binary", {}, "cleanup");
      assert.notEqual(close.isError, true);
    } catch (cause) {
      report.close_failure = String(cause);
      process.exitCode = 1;
    }
  report.elapsed_ms = performance.now() - started;
  if (
    !(await finalizeRetainedQueryReceipt({
      report,
      client,
      transport,
      account,
      serverLog,
      serverLogFinished,
      output: values.output,
      transcript,
    }))
  )
    process.exitCode = 1;
}
