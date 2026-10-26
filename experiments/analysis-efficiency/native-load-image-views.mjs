/** Actual Ghidra/MCP load observations with retained-page and readelf oracles. */
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
if (values.control) values.control = resolve(values.control);
assert.ok(["complete", "summary"].includes(values.mode));
await mkdir(values.output);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const { parseEvidence } = await import(
  pathToFileURL(join(values.runtime, "dist/domain/evidence.js")).href
);
const { stdout: revision } = await promisify(execFile)("git", [
  "-C",
  values.runtime,
  "rev-parse",
  "HEAD",
]);
const { stdout: workingState } = await promisify(execFile)("git", [
  "-C",
  values.runtime,
  "status",
  "--porcelain",
]);
const targetSha256 = hash(await readFile(values.target));
const { stdout: oracle } = await promisify(execFile)(
  "readelf",
  ["-Wr", values.target],
  { maxBuffer: 64 * 1024 ** 2 },
);
const relocationOffsets = [
  ...oracle.matchAll(/^([0-9a-f]+)\s+[0-9a-f]+\s+R_\S+/gm),
].map((row) => row[1]);
await writeFile(join(values.output, "readelf-relocations.txt"), oracle);
const { stdout: programHeaders } = await promisify(execFile)(
  "readelf",
  ["-Wl", values.target],
  { maxBuffer: 1024 ** 2 },
);
const loadAddresses = [
  ...programHeaders.matchAll(/^\s*LOAD\s+0x[0-9a-f]+\s+0x([0-9a-f]+)/gm),
].map((row) => BigInt(`0x${row[1]}`));
assert.ok(loadAddresses.length > 0, "Expected an ELF load mapping");
const lowestLoad = loadAddresses.reduce((left, right) =>
  left < right ? left : right,
);
await writeFile(
  join(values.output, "readelf-program-headers.txt"),
  programHeaders,
);
const isolatedHome = await mkdtemp(join(tmpdir(), "rea-load-image-verifier-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(values.runtime, "scripts/rea.mjs"), "mcp"],
  cwd: values.runtime,
  env: {
    HOME: isolatedHome,
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
const serverLog = createWriteStream(join(values.output, "server.log"));
const serverLogFinished = finished(serverLog);
serverLogFinished.catch(() => {});
transport.stderr?.pipe(serverLog);
const client = new Client({ name: "native-load-image-views", version: "1" });
const transcript = [];
const report = {
  mode: values.mode,
  runtime: values.runtime,
  revision: revision.trim(),
  dirty: workingState.length > 0,
  artifact: { path: values.target, sha256: targetSha256 },
  oracle: {
    command: ["readelf", "-Wr", values.target],
    sha256: hash(oracle),
    relocation_count: relocationOffsets.length,
  },
  question:
    "Report retained load-image verification status, collection counts, and the first four relocation addresses/statuses with source linkage.",
  calls: [],
  runs: [],
};
const call = createRetainedQueryCaller(client, (receipt, event) => {
  report.calls.push(receipt);
  transcript.push(event);
});
const result = async (name, input, phase = name) => {
  const reply = await call(name, input, phase);
  assert.notEqual(reply.isError, true, JSON.stringify(reply));
  assert.ok(reply.structuredContent);
  return reply.structuredContent;
};
const exportedParent = async (id, label) => {
  const path = join(values.output, `${label}-evidence.json`);
  await result("export_evidence_bundle", { path }, `${label}:export`);
  const bundle = JSON.parse(await readFile(path, "utf8"));
  const parent = bundle.records.find((record) => record.evidence_id === id);
  assert.ok(parent, `Missing retained source ${id}`);
  assert.equal(parent.operation, "inspect_native_load_image");
  assert.equal(parent.subject.digest.sha256, targetSha256);
  assert.equal(parent.provider.id, "ghidra");
  return parseEvidence(parent);
};
const selectedRecords = (rows) =>
  rows.slice(0, 4).map(({ address, status }) => ({ address, status }));
let opened = false;
const started = performance.now();
try {
  await client.connect(transport);
  const catalogStart = performance.now();
  const catalog = await client.listTools();
  assert.equal(catalog.nextCursor, undefined);
  await writeFile(join(values.output, "catalog.json"), JSON.stringify(catalog));
  report.catalog = {
    elapsed_ms: performance.now() - catalogStart,
    bytes: Buffer.byteLength(JSON.stringify(catalog)),
    sha256: hash(JSON.stringify(catalog)),
  };
  const definitions = new Map(catalog.tools.map((tool) => [tool.name, tool]));
  const original = client.callTool.bind(client);
  client.callTool = (input, options) =>
    original(input, {
      ...options,
      timeout: 600000,
      toolDefinition: definitions.get(input.name),
    });
  await result("open_binary", { path: values.target, provider_id: "ghidra" });
  opened = true;
  for (const temperature of ["cold", "warm"]) {
    const runStart = performance.now();
    const reply = await call(
      "inspect_native_load_image",
      values.mode === "summary" ? { detail: "summary" } : {},
      temperature,
    );
    let parent;
    let delivered;
    let id;
    if (reply.isError) {
      assert.equal(values.mode, "complete");
      const text = reply.content.find((item) => item.type === "text");
      assert.ok(text);
      const error = JSON.parse(text.text).error;
      assert.equal(error.code, "resource_constraint");
      assert.equal(error.details.reported_limits.boundary, "mcp-response");
      id = error.details.reported_limits.evidence_reference.evidence_id;
      parent = await exportedParent(id, temperature);
      delivered = parent.normalized_result;
    } else {
      assert.ok(reply.structuredContent);
      delivered = reply.structuredContent.normalized_result;
      id =
        values.mode === "summary"
          ? delivered.parent_evidence_id
          : reply.structuredContent.evidence_id;
      parent = await exportedParent(id, temperature);
      if (values.mode === "complete")
        assert.deepEqual(parent, reply.structuredContent);
    }
    const source = parent.normalized_result;
    const observed = source.observations;
    // Every file-table coordinate must survive, including repeated coordinates.
    // Provider-added observations are retained separately; this oracle does not
    // independently establish why the provider created them.
    const base = BigInt(observed.image_base.split(":").at(-1));
    const counts = new Map();
    for (const row of observed.relocations) {
      const key = (BigInt(row.address.split(":").at(-1)) - base).toString(16);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const offset of relocationOffsets) {
      const key = (BigInt(`0x${offset}`) - lowestLoad).toString(16);
      const remaining = counts.get(key) ?? 0;
      assert.ok(remaining > 0, `Missing ELF relocation coordinate 0x${key}`);
      counts.set(key, remaining - 1);
    }
    const providerOnly = [...counts]
      .filter(([, count]) => count > 0)
      .map(([relative_address, count]) => ({
        relative_address: `0x${relative_address}`,
        count,
      }));
    const facts = {
      observation_sha256: hash(JSON.stringify(observed)),
      verification: {
        status: source.status,
        ...(source.status === "unsupported"
          ? { reason: source.reason }
          : { format: source.format }),
      },
      counts: {
        source_files: observed.source_files.length,
        mappings: observed.mappings.length,
        relocations: observed.relocations.length,
        entry_points: observed.entry_points.length,
        entry_context: observed.entry_context.length,
        metadata_recovery: observed.metadata_recovery?.length ?? null,
        checks: source.checks?.length ?? null,
        sections: source.sections?.length ?? null,
      },
      records: selectedRecords(observed.relocations),
    };
    if (values.mode === "summary") {
      assert.equal(delivered.parent_operation, parent.operation);
      assert.equal(delivered.parent_digest, parent.evidence_id.slice(3));
      assert.equal(delivered.summary.verification.status, source.status);
      assert.deepEqual(delivered.summary.counts, facts.counts);
      assert.ok(!Object.hasOwn(delivered.summary.observation, "relocations"));
      const selected = await result(
        "inspect_analysis_view",
        {
          source: { kind: "retained-evidence", evidence_id: id },
          view: {
            kind: "native-load-image",
            collection: "relocations",
            offset: 0,
            limit: 4,
            fields: ["address", "status"],
          },
        },
        `${temperature}:selected-relocations`,
      );
      assert.deepEqual(
        selected.normalized_result.items.rows,
        facts.records.map((record, source_index) => ({ source_index, record })),
      );
      assert.equal(
        selected.normalized_result.verification_status,
        source.status,
      );
      assert.equal(
        selected.normalized_result.coverage.total,
        observed.relocations.length,
      );
      const tail = await result(
        "inspect_analysis_view",
        {
          source: { kind: "retained-evidence", evidence_id: id },
          view: {
            kind: "native-load-image",
            collection: "relocations",
            indices: [observed.relocations.length - 1],
            fields: ["address", "original_bytes_hex", "memory_bytes_hex"],
          },
        },
        `${temperature}:tail-relocation`,
      );
      const last = observed.relocations.at(-1);
      assert.deepEqual(tail.normalized_result.items.rows, [
        {
          source_index: observed.relocations.length - 1,
          record: {
            address: last.address,
            original_bytes_hex: last.original_bytes_hex,
            memory_bytes_hex: last.memory_bytes_hex,
          },
        },
      ]);
      const checks = await result(
        "inspect_analysis_view",
        {
          source: { kind: "retained-evidence", evidence_id: id },
          view: { kind: "native-load-image", collection: "checks", limit: 1 },
        },
        `${temperature}:verification-checks`,
      );
      assert.equal(source.status, "unsupported");
      assert.equal(checks.normalized_result.items.rows, null);
    }
    assert.deepEqual(parent.parameters, {});
    await writeFile(
      join(values.output, `${temperature}-facts.json`),
      JSON.stringify(facts),
    );
    if (values.control)
      assert.deepEqual(
        facts,
        JSON.parse(
          await readFile(
            join(values.control, `${temperature}-facts.json`),
            "utf8",
          ),
        ),
      );
    report.runs.push({
      temperature,
      parent_evidence_id: id,
      source_provider: parent.provider,
      source_analysis_profile_digest: parent.analysis_profile?.digest ?? null,
      reply_refused: reply.isError === true,
      complete_evidence_bytes: Buffer.byteLength(JSON.stringify(parent)),
      facts_sha256: hash(JSON.stringify(facts)),
      provider_only_relocation_coordinates: providerOnly,
      elapsed_ms: performance.now() - runStart,
    });
  }
  assert.equal(hash(await readFile(values.target)), targetSha256);
  report.status = "passed";
} catch (cause) {
  report.status = "failed";
  report.failure = String(cause?.stack ?? cause);
  process.exitCode = 1;
} finally {
  if (opened) {
    try {
      await result("close_binary", {});
    } catch (cause) {
      report.status = "failed";
      report.close_failure = String(cause);
      process.exitCode = 1;
    }
  }
  report.elapsed_before_finalization_ms = performance.now() - started;
  if (
    !(await finalizeRetainedQueryReceipt({
      report,
      client,
      transport,
      account: isolatedHome,
      serverLog,
      serverLogFinished,
      output: values.output,
      transcript,
    }))
  )
    process.exitCode = 1;
}
