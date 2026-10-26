# Native load-image delivery verification

`native-load-image-views.mjs` runs the compiled production stdio MCP server with
a caller-selected Ghidra and JDK. It compares complete delivery with a summary
plus selected relocation pages, then exports and authenticates the complete
parent. Every call uses its actual advertised SDK contract. Both cold and warm
reads run in one fresh server; OS file caches are not declared cold.

Build each selected runtime with the pinned toolchain. Use absolute paths or
paths relative to the verifier's launch directory, and new output directories:

```sh
node experiments/analysis-efficiency/native-load-image-views.mjs \
  --runtime /path/to/baseline --mode complete \
  --target /usr/lib/x86_64-linux-gnu/libcrypto.so.3 \
  --ghidra /path/to/ghidra_12.1.4_PUBLIC --java /path/to/jdk-21 \
  --output /new/baseline-report
node experiments/analysis-efficiency/native-load-image-views.mjs \
  --runtime /path/to/feature --mode summary \
  --target /usr/lib/x86_64-linux-gnu/libcrypto.so.3 \
  --ghidra /path/to/ghidra_12.1.4_PUBLIC --java /path/to/jdk-21 \
  --output /new/summary-report --control /new/baseline-report
```

The question is the verification state, all collection counts, and the first
four relocation addresses/statuses. The summary path additionally checks the
last relocation's recorded bytes and unavailable independent verification
checks. It never treats ELF observations as verified. Complete delivery can
exceed the MCP response limit: the baseline then follows the reported retained
reference, exports its source and selects facts locally. That recovery is an
extra workflow, not a successful complete inline MCP reply. Include its calls
and local reads when comparing completed tasks.

The independent GNU `readelf -Wr` oracle checks that every file-table relocation
coordinate survives, including multiplicity. `readelf -Wl` supplies the original
PT_LOAD base independently of Ghidra's chosen import base. Producer order can
differ. Additional provider observations are retained and reported separately;
this oracle does not independently verify their origin. Full observation
digests and selected facts must agree with the control run.

The target SHA-256, native oracle output, raw catalog, arguments/replies,
complete Evidence and phase durations stay in the output directory. Measure
whole-process-family elapsed time, CPU and peak memory externally, with bounded
CPU/heap and a memory stop condition. The child requests a 1.5 GiB Ghidra heap
and a 3 GiB Node heap; neither is a whole-family RSS bound. Estimate tokens over
catalog discovery, arguments, all replies and local recovery facts using a named
tokenizer. Raw serialized schema estimates are not actual model usage; protocol
framing, prompts and client rendering remain unmeasured.

The shared receipt finalizer closes both transports, removes its owned workspace
after successful cleanup, and preserves cleanup/publication failures in the
report. Its phase elapsed field precedes final receipt publication; external
whole-family measurements must include that finalization.

## Recorded Linux x64 verification

One fresh cold/warm session per revision used Node 24.22.1, Ghidra 12.1.4,
two CPUs and the system `libcrypto.so.3` with SHA-256
`76dd3d93e5ee48950a92a58d59b94de8143847f91a80d9682c938767b991577d`.
Baseline `42382651b` has the same tree as main `fc43e285e`; feature `7a53a4a7f`.
Both retained the same parent ID and 21,118 observations. GNU readelf declared
21,117 relocation coordinates, all present; one provider-only coordinate at
relative `0x47dc60` remained visible without an independently established origin.

| Whole two-capture harness               |      Complete + local recovery | Summary + selected reads |
| --------------------------------------- | -----------------------------: | -----------------------: |
| Direct capture reply                    | Refused at the 10 MiB boundary |              9,787 bytes |
| Complete parent Evidence                |                9,114,888 bytes |          9,114,888 bytes |
| Raw serialization, cl100k_base estimate |                 912,927 tokens |           936,730 tokens |
| Elapsed                                 |                       164.93 s |                 169.88 s |
| Process-family CPU                      |                       281.75 s |                 293.06 s |
| Sampled process-family RSS peak         |                       2.01 GiB |                 2.30 GiB |

Token estimates include one raw catalog discovery, call arguments/replies and
baseline local recovery facts. Local command text, prompts, protocol framing
and client rendering were not measured; these are not model-usage totals.
The summary harness also checks tail bytes and unavailable checks through
additional RPCs. Neither lower task tokens, faster analysis nor lower memory
is established by this single pair. The benefit is direct bounded MCP access
to facts that previously required an export and local selection. RSS summed
the owned process family every 100 ms; shared pages can be double-counted and
short peaks missed. OS caches were warm.

The real CLI published the same complete parent with summary delivery, then a
separate CLI process read selected first/last rows from that bundle without
configured Ghidra/JDK. That file-page read took 4.83 s, 5.89 CPU seconds and
0.51 GiB sampled family RSS. This verifies historical projection independently
of reopening a native provider. Other hosts, engines and formats were not
verified in this experiment.
