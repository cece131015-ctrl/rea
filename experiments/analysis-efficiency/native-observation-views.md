# Retained native observations and context

This experiment answers one fixed question over the unmodified stripped Linux
`/usr/bin/ls`: resolve 21 recorded functions, inspect every recorded caller/callee
relation and containing-function outcome, two complete graphs, and one missing
symbol. Repeat in the same session. Both lanes read all facts, source profiles,
and source caveats; no completeness advantage is inferred from smaller replies.

The final complete control uses `5d428390996498bc4dcca4da934641557f9109bc`,
after the unrelated input-schema fitting revert. The first control used
`2b0aa212156fe125c60aea8fd73092329e25dd09` (merged as `6381aa0b1`).
This already includes request-scoped Ghidra input-error diagnostics, so those
savings are not attributed to observation views. The candidate uses the
implementation in this PR. Both discover the entire actual compact SDK catalog,
use the same full 652-row inventory to choose seeds, and use named SDK tool
definitions for response validation. The summary client keeps exact-digest
context/profile values within this one investigation. The server adds no cache.

The first 64 observations arrive inline. Because this question explicitly needs
every remaining observation and every caveat, the client requests subsequent
pages of up to 512 entries. It decodes each graph page's message dictionary,
preserves original source indices, levels, duplicate text, optional fields,
failed nodes and coverage, and checks every reconstructed result against the
authenticated exported complete parent. All 65 original Evidence IDs and all
facts match the control in cold and warm phases. This establishes preservation
of the real Ghidra output, not independent completeness of Ghidra discovery.
Separate source fixtures establish graph ordering, duplicate/Unicode caveats,
empty levels, partial/unknown coverage, negative resolution, malformed omitted
rows, and authenticated path-alias identity.

## Environment and reproduction

- Target SHA-256: `cb30d69b24245bf2ecdc9e7f53bbad19159999970b6d82c0c00c7d32d9e37aa4`.
- Linux x86-64; Node 24.22.1; Ghidra 12.1.4; JDK 21.0.12.1.
- Fresh MCP process and Ghidra session for each lane; warm OS file caches.
  The warm phase reuses the same provider session and the client's validated
  context values. This is not a cold-disk comparison.
- Two CPU affinity slots; Node old-space limit 3 GiB and Ghidra heap 1536 MiB.
  An external supervisor sampled the whole process family's summed RSS every
  100 ms, stopped at 8 GiB or below 4 GiB available host memory, and enforced a
  300-second deadline. No resource stop occurred. RSS can double-count shared
  pages and miss short peaks. CPU includes driver, SDK, REA and Java descendants.

Build both worktrees with the pinned toolchain. Run this PR's driver against
each built runtime, with separate new output directories:

```sh
node experiments/analysis-efficiency/native-observation-views.mjs \
  --runtime /absolute/control --target /usr/bin/ls --output /tmp/native-control \
  --ghidra /absolute/ghidra --java /absolute/jdk --mode complete
node experiments/analysis-efficiency/native-observation-views.mjs \
  --runtime /absolute/candidate --target /usr/bin/ls --output /tmp/native-summary \
  --ghidra /absolute/ghidra --java /absolute/jdk --mode summary \
  --control /tmp/native-control
```

Apply a process-family resource supervisor appropriate to the host. The driver
itself does not impose a family-memory limit. Each output keeps the actual
catalog, every RPC argument/reply, complete Evidence export, per-phase facts,
server log and completion/cleanup receipts. Failed runs retain their receipt.

## Measurements

| Completed task                                   | Complete control | Summary + complete context |
| ------------------------------------------------ | ---------------: | -------------------------: |
| RPCs                                             |              137 |                        179 |
| Catalog token estimate                           |          919,115 |                    932,545 |
| Catalog + arguments + text token estimate        |        1,243,161 |                  1,234,768 |
| Catalog + arguments + raw replies token estimate |        1,587,863 |                  1,554,038 |
| All reply text bytes                             |        1,331,358 |                  1,006,503 |
| Whole-family elapsed seconds                     |            39.38 |                      41.06 |
| Whole-family CPU seconds                         |            69.26 |                       70.4 |
| Sampled family peak RSS GiB                      |             1.45 |                       1.69 |

The completed-task text estimate decreases 0.68%; raw-reply accounting decreases
2.13%, and text bytes decrease 24.4%. The large forward graph's first reply is
63,888 → 5,150 estimated text tokens (283,990 → 15,995 bytes); remaining facts
and all caveats are included in the completed-task table. A one-address callee
reply is only 754 → 744 tokens despite 3,104 → 2,326 bytes: bytes alone would
overstate its token improvement. There is no demonstrated time or memory
improvement. The complete-read workflow adds 42 RPCs; its warm phase is
0.762 → 1.005 seconds. Cold phases are 33.151 → 34.804 seconds. This one fresh
session per final lane cannot separate provider-startup variance from overhead.
The final candidate implementation and experiment driver are `4ac1971864`;
the final control is `5d428390996`. CPU and RSS remain within the stated guard
but are higher. An earlier pre-review pair measured 34.55 → 50.29 seconds,
so elapsed-time variance must not be mistaken for a speed improvement.

Token estimates use `cl100k_base` over one pass of raw catalog JSON plus every
RPC's arguments and text content. A second accounting counts the full raw RPC
reply, including duplicate structured/text representations. Both include page,
context, error, export and close calls. They exclude prompts, MCP initialization,
JSON-RPC envelopes, host rendering and replay, and are not actual model usage.
Catalog discovery dominates this example. No claim of better model reasoning
or complete discovery follows from these counts.

A first control attempt completed both investigations but its experiment driver
incorrectly parsed the export acknowledgement as Evidence; it failed during
verification, cleaned up, and was rerun after correcting the driver. A first
candidate with 64-entry continuation pages and duplicated coverage/verbose
caveat instructions increased the completed-task text token estimate by 1.2%.
That result was retained; the final implementation removes repeated coverage
from the normalized payload (the Evidence envelope owns it), shortens the
instructions, and the complete-read client requests larger continuation pages.
Neither failed/development attempt is included in the final paired task table.

Review regressions also cover context-facet partial/unknown relationship
coverage and actionable overflow continuations through all five native tools
without another provider read. The latter injects a 32 KiB delivery budget to
exercise capacity cheaply; it does not establish a real 10 MiB graph failure.
Actual missing-target and failing-Git commands each publish a failed receipt
without leaking a temporary HOME. Thirteen deterministic receipt tests also
cover partially acquired resources and failed cleanup.
