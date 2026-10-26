# Browser scenario summary verification

The verifier runs the actual compiled CLI/MCP and caller-selected Chromium against
TodoMVC's JavaScript ES5 distribution served on loopback. Ten actions add five
todos. Every step captures URL, DOM, accessibility and a screenshot; the oracle
checks all completed steps, the five authored labels, retained events and
transaction identities. Summary runs also read step, text and transaction pages
and authenticate an exported complete parent.

Download the public distribution at the pinned revision into a disposable folder:

```bash
export REA_TODOMVC_APP="$(mktemp -d)"
python3 - "$REA_TODOMVC_APP" <<'PY'
import hashlib, json, sys, urllib.request
from pathlib import Path
root = Path(sys.argv[1])
revision = "ff43b02e59dfa604386bb382034b2cd07c2bcd8a"
files = ["index.html", "app.js", "base.css", "base.js", "controller.js",
         "helpers.js", "index.css", "model.js", "store.js", "template.js", "view.js"]
manifest = []
for name in files:
    url = f"https://raw.githubusercontent.com/tastejs/todomvc/{revision}/examples/javascript-es5/dist/{name}"
    with urllib.request.urlopen(url, timeout=30) as reply:
        data = reply.read()
    (root / name).write_bytes(data)
    manifest.append({"path": name, "url": url, "bytes": len(data),
                     "sha256": hashlib.sha256(data).hexdigest()})
(root / "provenance.json").write_text(json.dumps({"revision": revision, "files": manifest}, indent=2))
PY
```

Build each selected checkout with the repository's pinned Node/npm toolchain.
Use new output directories; exports never overwrite an earlier run:

```bash
node experiments/analysis-efficiency/browser-scenario-summary.mjs \
  --repository /absolute/path/to/baseline --mode complete \
  --application "$REA_TODOMVC_APP" --browser /absolute/path/to/chromium \
  --output /absolute/path/to/new-baseline-report
node experiments/analysis-efficiency/browser-scenario-summary.mjs \
  --mode summary --application "$REA_TODOMVC_APP" \
  --browser /absolute/path/to/chromium \
  --output /absolute/path/to/new-summary-report
```

`cold` is the first capture in a fresh MCP process; `warm` repeats the capture in
that process with a new owned browser/profile. Neither label establishes cold OS
file caches. Summary mode intentionally performs additional retained queries.
Compare equivalent answers and include those calls when reporting task cost;
smaller replies alone do not establish a faster task.

Add `--verify-boundaries` to a separate summary run for a real failed-step focus,
CLI summary publication, and MCP text readback from the CLI's complete bundle.
Those extra checks make its whole-run resource cost unsuitable for comparison
against a complete-only run.

Reports retain the actual catalog, arguments, MCP text and complete Evidence.
When estimating tokens, name the tokenizer and count discovery, arguments and
all replies needed for the chosen task. Raw serialized catalog estimates are
not actual model usage or a measurement of a client's rendered tool definitions.
Measure CPU and peak process-family memory externally, state the accounting
method, and include cleanup; the verifier's elapsed phase excludes final teardown.
