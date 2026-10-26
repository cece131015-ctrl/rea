/** Real CLI/SDK capacity investigations; synthetic inputs are explicitly labelled. */
import assert from "node:assert/strict";
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
const { values: v } = parseArgs({
  options: {
    ...Object.fromEntries(
      [
        "runtime",
        "left",
        "right",
        "output",
        "adapter",
        "allowance",
        "rows",
      ].map((k) => [k, { type: "string" }]),
    ),
    refusal: { type: "boolean", default: false },
  },
});
for (const k of ["runtime", "output"]) {
  assert.ok(v[k]);
  v[k] = resolve(v[k]);
}
assert.ok(["cli", "mcp"].includes(v.adapter));
await mkdir(v.output);
let account, client, transport, serverLog, serverLogFinished, call;
const report = {
    adapter: v.adapter,
    runtime: v.runtime,
    synthetic_rows: v.rows ? Number(v.rows) : null,
    allowance: v.allowance ? Number(v.allowance) : null,
    calls: [],
    runs: [],
  },
  transcript = [];
const start = performance.now();
try {
  const load = (p) => import(pathToFileURL(join(v.runtime, p)).href);
  const { createEvidence, parseEvidence } = await load(
    "dist/domain/evidence.js",
  );
  const { createEvidenceBundle, parseEvidenceBundle } = await load(
    "dist/domain/evidenceBundle.js",
  );
  const { nativeFunctionMatchingSchema } = await load(
    "dist/domain/native/functionMatching.js",
  );
  report.revision = (
    await promisify(execFile)("git", ["-C", v.runtime, "rev-parse", "HEAD"])
  ).stdout.trim();
  const sources = [];
  for (const [index, key] of ["left", "right"].entries()) {
    if (v.rows) {
      const count = Number(v.rows);
      assert.ok(Number.isSafeInteger(count) && count > 0);
      const source = createEvidence(
        {
          path: `/synthetic/${key}.elf`,
          sha256: String(index + 1).repeat(64),
          format: "elf",
          architecture: "x86_64",
        },
        {
          id: "fixture.capacity",
          name: "Synthetic capacity fixture",
          version: "1",
        },
        {
          operation: "list_procedures",
          parameters: {},
          result: Array.from({ length: count }, (_, i) => ({
            address: `0x${(0x400000 + index * 0x400000 + i * 16).toString(16)}`,
            value: `subsystem_function_${i}`,
            symbol: {
              primary: true,
              dynamic: false,
              external: false,
              type: "Function",
              source: "imported",
            },
            procedure: { external: false, thunk: false, thunk_target: null },
          })),
          limitations: [
            "Synthetic Ghidra-shaped inventory; no native provider ran.",
          ],
        },
      );
      v[key] = join(v.output, `${key}.evidence.json`);
      await writeFile(v[key], JSON.stringify(createEvidenceBundle([source])), {
        flag: "wx",
      });
      sources.push(source);
    } else {
      assert.ok(v[key], `Missing --${key}`);
      v[key] = resolve(v[key]);
      const bundle = parseEvidenceBundle(
        JSON.parse(await readFile(v[key], "utf8")),
      );
      const inventories = bundle.records.filter(
        (e) => e.operation === "list_procedures",
      );
      assert.equal(inventories.length, 1);
      sources.push(inventories[0]);
    }
  }
  const request = {
    left: { kind: "retained-evidence", evidence_id: sources[0].evidence_id },
    right: { kind: "retained-evidence", evidence_id: sources[1].evidence_id },
    detail: "summary",
  };
  report.input_kind = sources.every((e) => e.provider.id === "fixture.capacity")
    ? "synthetic"
    : "captured-provider";
  if (report.input_kind === "synthetic")
    report.synthetic_rows = sources[0].normalized_result.length;
  report.sources = sources.map((e, i) => ({
    path: v[["left", "right"][i]],
    evidence_id: e.evidence_id,
    subject: e.subject,
    provider: e.provider,
    profile_digest: e.analysis_profile?.digest ?? null,
    rows: e.normalized_result.length,
  }));
  account = await mkdtemp(join(tmpdir(), "rea-matching-capacity-"));
  const environment = {
    HOME: account,
    PATH: process.env.PATH,
    NODE_OPTIONS: "--max-old-space-size=3072",
    REA_LOG_LEVEL: "silent",
    REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
  };
  const errorOf = (reply) =>
    JSON.parse(reply.content.find((c) => c.type === "text").text).error;
  let parentId,
    bundlePath = join(v.output, "matching.evidence.json");
  if (v.adapter === "cli") {
    if (v.allowance)
      environment.REA_NATIVE_MATCHING_REPRESENTATION_BYTES = v.allowance;
    const path = join(v.output, "request.json");
    await writeFile(path, JSON.stringify(request));
    const args = [
      join(v.runtime, "scripts/rea.mjs"),
      "match-native-functions",
      path,
      "--source_bundle",
      v.left,
      "--source_bundle",
      v.right,
      "--evidence_output",
      bundlePath,
      "--json",
    ];
    let result,
      exit = 0;
    const at = performance.now();
    try {
      result = await promisify(execFile)(process.execPath, args, {
        cwd: v.runtime,
        env: environment,
        maxBuffer: 16 * 1024 ** 2,
        timeout: 300000,
      });
    } catch (cause) {
      if (cause.code !== 1) throw cause;
      result = cause;
      exit = 1;
    }
    await writeFile(join(v.output, "cli.stdout.json"), result.stdout);
    await writeFile(join(v.output, "cli.stderr.log"), result.stderr ?? "");
    const reply = JSON.parse(result.stdout);
    report.runs.push({
      phase: "cold",
      elapsed_ms: performance.now() - at,
      exit_code: exit,
    });
    transcript.push({
      name: "match-native-functions",
      input: request,
      args,
      reply,
    });
    if (exit) {
      assert.equal(v.refusal, true);
      assert.equal(reply.code, "resource_constraint");
      assert.equal(reply.retryable, false);
      report.refusal = reply;
      report.outcome = "refused";
    } else {
      assert.equal(v.refusal, false);
      const e = parseEvidence(reply.summary);
      assert.equal(reply.evidence_bundle.path, bundlePath);
      parentId = e.normalized_result.parent_evidence_id;
      report.runs[0].summary = e.normalized_result.summary;
      report.outcome = "matched";
    }
  } else {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(v.runtime, "scripts/rea.mjs"), "mcp"],
      cwd: v.runtime,
      env: environment,
      stderr: "pipe",
    });
    serverLog = createWriteStream(join(v.output, "server.log"));
    serverLogFinished = finished(serverLog);
    serverLogFinished.catch(() => {});
    transport.stderr?.pipe(serverLog);
    client = new Client({ name: "native-matching-capacity", version: "1" });
    call = createRetainedQueryCaller(client, (receipt, event) => {
      report.calls.push(receipt);
      transcript.push(event);
    });
    await client.connect(transport);
    const catalog = await client.listTools();
    await writeFile(join(v.output, "catalog.json"), JSON.stringify(catalog));
    const definitions = new Map(catalog.tools.map((t) => [t.name, t]));
    const original = client.callTool.bind(client);
    client.callTool = (input, options) =>
      original(input, {
        ...options,
        timeout: 300000,
        toolDefinition: definitions.get(input.name),
      });
    const good = async (name, input, phase) => {
      const r = await call(name, input, phase);
      if (r.isError) {
        const e = errorOf(r);
        throw new Error(`${name}: ${e.code}: ${e.message}`);
      }
      return r;
    };
    for (const side of ["left", "right"])
      await good("import_evidence_bundle", { path: v[side] }, `import:${side}`);
    const initial = await call("match_native_functions", request, "default");
    if (initial.isError) {
      const e = errorOf(initial);
      assert.equal(e.code, "resource_constraint");
      assert.equal(e.retryable, false);
      report.refusal = e;
      report.default_admitted = false;
    } else {
      report.default_admitted = true;
      parentId = parseEvidence(initial.structuredContent).normalized_result
        .parent_evidence_id;
    }
    if (v.allowance) {
      await good(
        "update_analysis_settings",
        {
          changes: [
            {
              setting: "native.matching_representation_bytes",
              action: "set",
              value: Number(v.allowance),
            },
          ],
        },
        "raise-budget",
      );
      for (const phase of ["first-raised", "repeat-raised"]) {
        const at = performance.now();
        const e = parseEvidence(
          (await good("match_native_functions", request, phase))
            .structuredContent,
        );
        const id = e.normalized_result.parent_evidence_id;
        if (parentId) assert.equal(id, parentId);
        parentId = id;
        report.runs.push({
          phase,
          elapsed_ms: performance.now() - at,
          summary: e.normalized_result.summary,
        });
      }
      report.outcome = "matched";
    } else if (initial.isError) {
      assert.equal(v.refusal, true);
      report.outcome = "refused";
    } else {
      assert.equal(v.refusal, false);
      report.outcome = "matched";
    }
    if (report.outcome === "matched") {
      report.selected = [];
      for (const offset of [
        ...new Set([0, Math.max(0, sources[0].normalized_result.length - 2)]),
      ]) {
        const e = parseEvidence(
          (
            await good(
              "inspect_analysis_view",
              {
                source: { kind: "retained-evidence", evidence_id: parentId },
                view: {
                  kind: "function-matches",
                  collection: "functions",
                  sides: ["left"],
                  fields: ["name"],
                  offset,
                  limit: 2,
                },
              },
              "selected-correspondences",
            )
          ).structuredContent,
        );
        assert.equal(
          e.normalized_result.coverage.total,
          sources[0].normalized_result.length,
        );
        for (const row of e.normalized_result.items) {
          const original = sources[0].normalized_result[row.source_index];
          assert.equal(row.inventory_evidence_id, sources[0].evidence_id);
          assert.equal(row.address, original.address);
          assert.equal(row.name, original.value);
        }
        report.selected.push(...e.normalized_result.items);
      }
      await good("export_evidence_bundle", { path: bundlePath }, "export");
      // Release the server's retained representation before offline verification.
      await client.close();
      await transport.close();
    }
  }
  if (report.outcome === "matched") {
    const bundle = parseEvidenceBundle(
      JSON.parse(await readFile(bundlePath, "utf8")),
    );
    const evidence = bundle.records.find((e) => e.evidence_id === parentId);
    assert.ok(evidence);
    const result = nativeFunctionMatchingSchema.parse(
      evidence.normalized_result,
    );
    assert.deepEqual(
      [result.left.evidence_id, result.right.evidence_id],
      sources.map((e) => e.evidence_id),
    );
    const seen = [new Set(), new Set()];
    for (const group of result.matches)
      for (const [side, key] of ["left", "right"].entries())
        for (const member of group[key]) {
          const source = sources[side];
          assert.equal(member.inventory_evidence_id, source.evidence_id);
          assert.ok(!seen[side].has(member.source_index));
          seen[side].add(member.source_index);
          const row = source.normalized_result[member.source_index];
          assert.ok(row);
          assert.equal(member.address, row.address);
          assert.equal(member.name, row.value);
          assert.ok(member.evidence_links.includes(source.evidence_id));
          if (report.synthetic_rows !== null) {
            assert.equal(group.state, "matched");
            assert.equal(group.basis, "exact-symbol");
            assert.equal(group.left.length, 1);
            assert.equal(group.right.length, 1);
            assert.equal(
              group.left[0].source_index,
              group.right[0].source_index,
            );
          }
        }
    assert.deepEqual(
      seen.map((s) => s.size),
      sources.map((e) => e.normalized_result.length),
    );
    if (report.synthetic_rows !== null)
      assert.deepEqual(result.summary, {
        matched: report.synthetic_rows,
        only_left: 0,
        only_right: 0,
        unresolved: 0,
      });
    else assert.ok(result.summary.matched > 0);
    for (const source of sources)
      assert.ok(
        bundle.records.some((e) => e.evidence_id === source.evidence_id),
      );
    report.parent_evidence_id = parentId;
    report.summary = result.summary;
    report.verified_members = seen.map((s) => s.size);
  }
  report.status = "passed";
} catch (cause) {
  report.status = "failed";
  report.failure = String(cause?.stack ?? cause);
  process.exitCode = 1;
} finally {
  report.elapsed_ms = performance.now() - start;
  if (
    !(await finalizeRetainedQueryReceipt({
      report,
      client,
      transport,
      account,
      serverLog,
      serverLogFinished,
      output: v.output,
      transcript,
    }))
  )
    process.exitCode = 1;
}
