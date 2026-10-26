import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
let parseEvidence, createEvidenceBundle;
import { createRetainedQueryCaller } from "./retained-query-calls.mjs";
import { finalizeRetainedQueryReceipt } from "./retained-query-finalization.mjs";
const { values } = parseArgs({
  options: Object.fromEntries(
    ["runtime", "target", "output", "ghidra", "java", "profile"].map((key) => [
      key,
      { type: "string" },
    ]),
  ),
});
for (const key of [
  "runtime",
  "target",
  "output",
  "ghidra",
  "java",
  "profile",
]) {
  assert.ok(values[key], `Missing --${key}`);
  values[key] = resolve(values[key]);
}
const target = values.target,
  output = values.output,
  repo = values.runtime;
await mkdir(output);
const report = {
    target,
    profile_scope:
      "Ghidra-reported function identities and defined strings under explicit disabled-analyzer profile; no claim of default-analysis or function-body completeness",
    calls: [],
  },
  transcript = [];
let account,
  transport,
  serverLog,
  serverLogFinished,
  client,
  call,
  opened = false;
const start = performance.now();
try {
  ({ parseEvidence } = await import(
    pathToFileURL(join(repo, "dist/domain/evidence.js")).href
  ));
  ({ createEvidenceBundle } = await import(
    pathToFileURL(join(repo, "dist/domain/evidenceBundle.js")).href
  ));
  report.sha256 = createHash("sha256")
    .update(await readFile(target))
    .digest("hex");
  const disabled = JSON.parse(await readFile(values.profile, "utf8")).names;
  report.disabled_analyzers = disabled;
  account = await mkdtemp(join(tmpdir(), "rea-large-native-inventory-"));
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(repo, "scripts/rea.mjs"), "mcp"],
    cwd: repo,
    env: {
      HOME: account,
      PATH: process.env.PATH,
      NODE_OPTIONS: "--max-old-space-size=3072",
      GHIDRA_INSTALL_DIR: values.ghidra,
      JAVA_HOME: values.java,
      GHIDRA_HEADLESS_MAXMEM: "3072M",
      REA_GHIDRA_STARTUP_TIMEOUT_MS: "600000",
      REA_GHIDRA_DISABLED_ANALYZERS: disabled.join(","),
      REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
      REA_LOG_LEVEL: "silent",
    },
    stderr: "pipe",
  });
  serverLog = createWriteStream(join(output, "server.log"));
  serverLogFinished = finished(serverLog);
  serverLogFinished.catch(() => {});
  transport.stderr?.pipe(serverLog);
  client = new Client({
    name: "large-native-inventory-verifier",
    version: "1",
  });
  call = createRetainedQueryCaller(client, (receipt, event) => {
    report.calls.push(receipt);
    transcript.push(event);
  });
  await client.connect(transport);
  const catalog = await client.listTools();
  await writeFile(join(output, "catalog.json"), JSON.stringify(catalog));
  const defs = new Map(catalog.tools.map((t) => [t.name, t]));
  const original = client.callTool.bind(client);
  client.callTool = (input, options) =>
    original(input, {
      ...options,
      timeout: 900000,
      toolDefinition: defs.get(input.name),
    });
  const raw = async (name, args, phase) => {
    const r = await call(name, args, phase);
    if (r.isError) {
      const e = JSON.parse(r.content.find((c) => c.type === "text").text).error;
      throw new Error(
        name +
          ": " +
          e.code +
          ": " +
          (e.details?.diagnostics?.failure_message ?? e.message),
      );
    }
    return r;
  };
  const good = async (name, args, phase) =>
    parseEvidence((await raw(name, args, phase)).structuredContent);
  await raw("open_binary", { path: target, provider_id: "ghidra" }, "open");
  opened = true;
  const procedures = await good(
    "list_procedures",
    { detail: "summary" },
    "functions",
  );
  report.procedures = procedures.normalized_result;
  const full = await call("list_strings", {}, "complete-strings");
  report.complete_strings_refused = full.isError === true;
  if (full.isError) {
    const error = JSON.parse(
      full.content.find((c) => c.type === "text").text,
    ).error;
    assert.equal(error.code, "resource_constraint");
    assert.equal(error.details.reported_limits.boundary, "mcp-response");
    report.overflow_evidence_id =
      error.details.reported_limits.evidence_reference.evidence_id;
  }
  const parentId =
    report.overflow_evidence_id ??
    parseEvidence(full.structuredContent).evidence_id;
  const strings = await good(
    "inspect_analysis_view",
    {
      source: { kind: "retained-evidence", evidence_id: parentId },
      view: { kind: "summary" },
    },
    "summary-strings",
  );
  const summary = strings.normalized_result;
  report.strings = summary;
  if (report.overflow_evidence_id)
    assert.equal(summary.parent_evidence_id, report.overflow_evidence_id);
  const selected = [];
  const total = summary.summary.row_count;
  for (const offset of [...new Set([0, Math.max(0, total - 3)])]) {
    const e = await good(
      "inspect_analysis_view",
      {
        source: {
          kind: "retained-evidence",
          evidence_id: summary.parent_evidence_id,
        },
        view: { kind: "native-inventory", offset, limit: 3, fields: ["value"] },
      },
      "selected-strings",
    );
    assert.equal(e.normalized_result.coverage.total, total);
    selected.push(...e.normalized_result.rows);
  }
  report.byte_oracles = [];
  const file = await open(target, "r");
  try {
    for (const row of selected) {
      const mapping = await good(
        "address_to_file_offset",
        { address: row.record.address },
        "string-file-coordinate",
      );
      const offset = mapping.normalized_result.file_offset;
      assert.ok(Number.isSafeInteger(offset));
      const expected = Buffer.from(row.record.value, "utf8"),
        bytes = Buffer.alloc(expected.length);
      const read = await file.read(bytes, 0, bytes.length, offset);
      assert.equal(read.bytesRead, bytes.length);
      const encoding =
        row.record.string?.encoding ?? row.record.decoding?.encoding;
      if (["utf-8", "UTF-8", "ascii", "ASCII", "US-ASCII"].includes(encoding))
        assert.deepEqual(bytes, expected);
      report.byte_oracles.push({
        source_index: row.source_index,
        address: row.record.address,
        file_offset: offset,
        encoding,
        utf8_bytes_match: bytes.equals(expected),
        bytes_sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  } finally {
    await file.close();
  }
  await raw(
    "export_evidence_bundle",
    { path: join(output, "complete-evidence.json") },
    "export",
  );
  await raw("close_binary", {}, "close");
  opened = false;
  const bundle = JSON.parse(
    await readFile(join(output, "complete-evidence.json"), "utf8"),
  );
  const source = parseEvidence(
    bundle.records.find((e) => e.evidence_id === summary.parent_evidence_id),
  );
  assert.equal(source.subject.digest.sha256, report.sha256);
  assert.equal(source.normalized_result.length, total);
  for (const row of selected)
    assert.equal(
      row.record.value,
      source.normalized_result[row.source_index].value,
    );
  const fn = parseEvidence(
    bundle.records.find(
      (e) => e.evidence_id === report.procedures.parent_evidence_id,
    ),
  );
  assert.equal(fn.subject.digest.sha256, report.sha256);
  report.procedure_count = fn.normalized_result.length;
  assert.deepEqual(
    fn.analysis_profile.parameters.analysis_options.disabled_analyzers,
    disabled,
  );
  assert.equal(
    fn.evidence_links.length,
    0,
    "This capture expects a self-contained inventory; retain its full source closure otherwise.",
  );
  await writeFile(
    join(output, "functions.evidence.json"),
    JSON.stringify(createEvidenceBundle([fn])),
    { flag: "wx" },
  );
  report.profile_digest = fn.analysis_profile.digest;
  report.source_string_count = source.normalized_result.length;
  report.status = "passed";
} catch (cause) {
  report.status = "failed";
  report.failure = String(cause?.stack ?? cause);
  process.exitCode = 1;
} finally {
  if (opened)
    try {
      const r = await call("close_binary", {}, "cleanup");
      assert.notEqual(r.isError, true);
    } catch (cause) {
      report.close_failure = String(cause);
      process.exitCode = 1;
    }
  report.elapsed_ms = performance.now() - start;
  if (
    !(await finalizeRetainedQueryReceipt({
      report,
      client,
      transport,
      account,
      serverLog,
      serverLogFinished,
      output,
      transcript,
    }))
  )
    process.exitCode = 1;
}
