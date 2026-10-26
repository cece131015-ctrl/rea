# Native matching capacity verification

The runtime setting changes admission headroom, not matching semantics. The
96 MiB default is preserved. This experiment checks the real CLI and stdio MCP
with synthetic Ghidra-shaped rows and a real pair of stripped LLVM inventories.
It is not evidence of faster matching or behavioral equivalence.

The control is main `14631f698`; candidate runtime is `115df89c9`, based on
Kaoru0822's #7112 (`87d3d6022`, `0600c7d11`) with main's #7108 provenance
accounting retained. Imported commits retain Kaoru's authorship and their
Claude Opus 5.5 co-author trailers.

## Synthetic capacity

Each side has 20,000 or 50,000 unique imported names, original source indices,
explicit symbol/procedure metadata and different addresses. Provider identity
and limitations explicitly label these as synthetic; no native provider ran.
The known answer is every row paired by its unique exact name, with no
left-only, right-only or unresolved groups. Verification authenticates complete
exports and checks every member against its original inventory identity,
index, address and name. MCP also reads first/last selected pages.

CLI uses two source bundles and writes the complete matching/source closure.
The control refuses both sizes at 96 MiB. The candidate succeeds with the
536870912-byte launch seed. MCP imports the same records, tries the default,
raises the runtime setting to 512 MiB and repeats matching twice. The 20k
retained case already fits the default; the 50k case is refused then recovers
without restarting or replacing inputs. Matching Evidence IDs remain stable
across allowance changes and repeated successful requests.

| Lane / rows per side | Outcome | Whole elapsed s | CPU s | Family peak GiB | Text token estimate |
| -------------------- | ------- | --------------: | ----: | --------------: | ------------------: |
| mcp-20000            | matched |           25.89 | 30.77 |            1.77 |             938,961 |
| mcp-50000            | matched |           71.74 | 81.87 |            2.31 |             938,209 |
| cli-20000            | matched |           27.55 | 31.04 |            1.02 |               1,166 |
| cli-50000            | matched |           63.61 | 70.37 |            1.53 |               1,138 |
| main-cli-20000       | refused |           10.45 | 12.28 |            0.72 |                 364 |
| main-cli-50000       | refused |           17.85 | 19.17 |            0.90 |                 357 |

These whole-harness costs include input preparation/authentication, client and
catalog work, matching, output publication and offline correctness checks.
MCP rows include the initial default attempt, settings change, two raised-budget
matches, two selected pages and export. CLI rows include one fresh invocation
and its complete export. The lanes do different amounts of validation/work;
these numbers are not an adapter speed comparison. A refused control does not
complete the matching task, so no completed-task speedup can be inferred.

The first successful MCP match is 3.535 s at 20k (under the default, before
raising it), and 12.393 s at 50k (first raised-budget call). Last repeated calls
are 3.216 s and 13.640 s. Original receipt phase labels `cold`/`warm` denoted
raised-budget call order; the published driver now uses `first-raised` and
`repeat-raised` to avoid mislabelling the already-warm 20k case. Every final
whole harness starts a fresh process; OS file caches are warm. CLI matching
invocations, including complete publication, are 19.546 s / 47.712 s; the extra
whole-harness cost is visible in the table.

Token estimates use cl100k_base over one raw catalog discovery, every argument
and every text reply, including refusal, settings, paging and export. CLI counts
its invocation arguments, request JSON and actual stdout. Local Evidence file
contents are not sent to the agent; their loading and checking are included in
resource costs. Catalog discovery dominates MCP. Initialization, JSON-RPC
framing, prompts, host rendering and replay are excluded; actual model usage
was not measured. The matching summary keeps the full report out of the MCP
frame; the complete 50k export is about 85 MiB and remains accessible locally.

## Real stripped inventories

The unmodified, stripped Linux x86-64 LLVM 14 and 15 shared libraries produce
43,643 and 45,230 Ghidra procedure observations. Target digests:

- LLVM 14: `436887791de0478d72c8323be99df69d6d0cf82745e5abec79d5e0374f4df560`.
- LLVM 15: `e45650cba881293ba3b6a0e7241920fc48fa4a522ca6dfda72dc94f5c54e44b0`.

Both MCP and CLI match the same complete inputs at 512 MiB: 34,008 exact-symbol
correspondences, 9,635 left-only observations and 11,222 right-only observations.
Every source row appears exactly once, with its original inventory ID, source
index, address and name. Matching Evidence IDs are identical between adapters
for both synthetic sizes and this real pair. The default retained request is
refused. Left/right-only observations do not establish actual product additions
or removals; inventory discovery completeness remains unknown.

An independent GNU `nm --without-symbol-versions --dynamic --no-demangle
--format=posix` comparison corroborates 32,935 matched raw dynamic symbol names.
The other 1,073 are not corroborated by that raw-name comparison (examples include
`<EXTERNAL>::lstat64`); no raw-name equivalence is claimed for that remainder.
The independent check costs 1.86 s elapsed/CPU and 0.34 GiB sampled RSS, in
addition to the matching harness. No byte fingerprints or decompilation were
supplied, and no behavioral-equivalence claim is made.

| Real matching lane | Whole elapsed s | CPU s | Family peak GiB | Text token estimate |
| ------------------ | --------------: | ----: | --------------: | ------------------: |
| real-mcp           |           56.04 | 62.63 |            2.11 |             943,676 |
| real-cli           |           74.04 | 79.28 |            1.36 |               2,482 |

The capture phase is measured separately: LLVM 14 takes 280.14 s elapsed,
366.63 s CPU and 2.88 GiB family RSS; LLVM 15 takes 278.39 s, 358.03 s and
3.11 GiB. These are actual REA/Ghidra MCP captures with Ghidra 12.1.4/JDK
21.0.12.1 and the explicitly committed 29-disabled-analyzer profile in
`native-inventory-profile.json`, with ASCII Strings enabled. This deliberately
narrow profile does not establish default-analysis or full body coverage.
The captures also validate 177,830/193,493 defined strings, retained summaries
and first/last pages after complete delivery exceeds 10 MiB. Six selected UTF-8
observations per target match independently read original-file bytes, including
non-default `.shstrtab` address-space observations. Exports are authenticated
before selecting unchanged, self-contained procedure Evidence into the two
function-only bundles; no Ghidra fact is reconstructed or relabelled.

End to end, sum both capture phases, the chosen matching lane and the independent
symbol check. Sequential peak RSS is the maximum of the phases. The actual
workflow used separate capture and matching connections, so its token accounting
must include three catalog discoveries and every capture RPC, not merely the
matching row above. Capture/discovery totals are reported below. Failed early
capture attempts (600 s SDK timeout, unregistered delayed-analyzer name, and a
driver exporting after session close) remain failed verification attempts;
all cleaned up without OOM. The final driver exports before closing, then
performs memory-intensive offline checks after the Java process has exited.

Capture reproduction (provide an appropriate process-family supervisor):

```sh
node experiments/analysis-efficiency/native-inventory-capture.mjs \
  --runtime /absolute/candidate --target /absolute/libLLVM.so \
  --output /tmp/llvm-capture --ghidra /absolute/ghidra --java /absolute/jdk \
  --profile experiments/analysis-efficiency/native-inventory-profile.json
```

Use each capture's `functions.evidence.json` as the matching driver's input.

| Capture                      | Catalog tokens | Arguments + replies | Total token estimate |
| ---------------------------- | -------------: | ------------------: | -------------------: |
| rea-6426-llvm14-inventory-v4 |        932,545 |              14,685 |              947,230 |
| rea-6406-llvm15-inventory    |        932,629 |              14,663 |              947,292 |

Both captures + real-mcp + independent symbol check: 616.42 s elapsed, 789.15 s CPU, 2,838,198 estimated text tokens; sequential sampled family peak 3.11 GiB.

Both captures + real-cli + independent symbol check: 634.43 s elapsed, 805.81 s CPU, 1,897,004 estimated text tokens; sequential sampled family peak 3.11 GiB.

Early failed capture attempts, excluded from those successful-run totals:

| Attempt                      | Elapsed s |  CPU s | Peak family GiB | Outcome                |
| ---------------------------- | --------: | -----: | --------------: | ---------------------- |
| rea-6426-llvm14-inventory    |    610.34 | 920.41 |            2.86 | SDK timeout            |
| rea-6426-llvm14-inventory-v2 |     39.26 |  66.81 |            2.16 | unregistered analyzer  |
| rea-6426-llvm14-inventory-v3 |    217.65 | 285.06 |            3.12 | driver export ordering |

## Reproduce

Use Node 24.22.1, the pinned npm install, and built runtime worktrees. Supply
new output directories. The driver keeps the catalog, actual RPC transcript,
phase receipts, complete matching bundle and verification results.

```sh
node experiments/analysis-efficiency/native-matching-capacity.mjs \
  --runtime /absolute/candidate --output /tmp/matching-50k \
  --adapter mcp --rows 50000 --allowance 536870912
node experiments/analysis-efficiency/native-matching-capacity.mjs \
  --runtime /absolute/candidate --output /tmp/matching-cli \
  --adapter cli --left /tmp/matching-50k/left.evidence.json \
  --right /tmp/matching-50k/right.evidence.json --allowance 536870912
```

For real data, replace the two paths with authenticated one-inventory bundles
captured from the desired targets; no provider is started by the matcher.
Omit allowance and use `--refusal` when a baseline refusal is the expected oracle.
Do not split inventories: that changes global uniqueness.

All measured runs used two CPU affinity slots and a supervisor with an 8 GiB
summed process-family RSS ceiling and a 4 GiB available-host-memory floor.
Node old space was 3 GiB. No resource stop or OOM occurred. RSS is summed every
100 ms, can count shared pages repeatedly and can miss short peaks. CPU includes
all waited descendants. The driver does not itself enforce a family limit;
apply a supervisor appropriate to the host. The 1 GiB setting maximum is a
representation policy, not a process-memory or host-capacity guarantee.

The small CLI harness pilot failed because it treated the documented
`{summary, evidence_bundle}` CLI envelope as bare Evidence; its failed receipt
was retained. The named envelope was corrected before all capacity measurements.
