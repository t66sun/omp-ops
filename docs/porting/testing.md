# Verifying the port

[中文](testing.zh.md)

There are two layers, and they answer different questions. The unit suite proves each transform in
isolation; the live smoke proves that a real omp session loads the extension and that the model's
tool results carry the promised shape. Neither reads model prose, so neither can be satisfied by a
well-written answer that did the wrong thing.

## The round gate

From the repository root:

```sh
node scripts/round-gate.mjs            # all seven steps
node scripts/round-gate.mjs --no-live  # skip the live step on a machine without omp
```

Each step answers a question a reviewer cannot answer from a diff:

| # | Step | Command | Question |
| --- | --- | --- | --- |
| 1 | `size` | `node scripts/check-file-size.mjs` | Does any tracked code file break the 1000-line rule? |
| 2 | `plugin` | `node scripts/check-omp.mjs` | Does the manifest resolve, is every module reachable, is anything shipped that the marketplace cannot install? |
| 3 | `unit` | `node --test omp/test/*.test.ts` | Does every transform still pass its own assertions? |
| 4 | `stubs` | scans `omp/src/**/*.ts` | Is any slice still a `STUB — replaced by slice …` no-op? |
| 5 | `inert` | scans `omp/src/{rules,render,dedup}/**` for `apply(...) { }` | Is any transform registered with an empty body? |
| 6 | `slices` | `node scripts/check-slices.mjs` | Did any two slices touch the same file? |
| 7 | `live` | `node omp/scripts/smoke.mjs` | Does a real omp session see the result? (needs `omp` on `PATH`) |

A passing run prints one `ok` line per step with its duration and ends with
`round gate passed: 7 step(s)`. A failing step prints its output under the `FAIL` line and the run
exits 1 with `round gate failed: N of 7 step(s)`. The gate is the merge criterion for a round, not
a formality: steps 3 and 4 exist because a no-op transform passes every type check and every
"does not throw" test.

## The install check

The round gate runs the extension from source, which cannot see the published path's failure mode: a
marketplace install loads `omp.extensions` and nothing else, so a feature that lives in its own entry
installs cleanly and then does nothing. Verify the shipped form by hand after any change to the
manifest:

```sh
omp plugin marketplace add t66sun/omp-ops --scope user
omp plugin install omp-ops@omp-ops --scope user
omp -p "Run the bash command 'false' and report the exact output."
```

The answer must contain the rendered line, and the tool result must carry `details["outcome.v1"]`:

```
Command exited with code 1
[outcome: error · effect unknown · retry after-input-change] Command exited with code 1; any file
writes or other side effects before the exit are unknown.
```

No `-e` flag is passed: the point is that a fresh install works with nothing else done. Uninstall with
`omp plugin uninstall omp-ops@omp-ops --scope user` when finished.

## The unit suite

```sh
node --test "omp/test/*.test.ts"
```

Current tree: **340 tests, 339 pass, 1 skipped**. The skip is
`omp/test/dedup-evidence.test.ts:76`, "a symlink to a regular file has no identity": the test needs
`fs.symlinkSync` to succeed, and a Windows account without symlink privilege raises `EPERM`, so the
case calls `t.skip(...)` (`omp/test/dedup-evidence.test.ts:83`) instead of failing. On a POSIX host,
or on Windows with developer mode, the same test runs and asserts that a symlink is judged as
itself, not as its target.

The suite is colocated under `omp/test/`, one file per concern: kernel rules, outcome projection,
the rendered line, dedup gates/evidence/epochs/limits, PTC projection and helpers, the extension
wiring, and the install surface. No test needs a network or a live session.

## The live smoke

```sh
node omp/scripts/smoke.mjs             # all five scenarios
node omp/scripts/smoke.mjs dedup       # one scenario
```

`OMP_BIN` overrides the binary (default `omp` on `PATH`); `SMOKE_MAX_TIME` overrides the per-call
`--max-time` (default `180` seconds). Each scenario gets a fresh temporary directory containing
`data.txt` (40 lines, `<n> | line <n> of the fixture`), and runs:

```sh
omp -p --mode json -e <repo>/omp/src/extension/index.ts --max-time <SMOKE_MAX_TIME> "<prompt>"
```

The harness parses stdout as line-delimited JSON, keeps `tool_execution_end` events that carry a
result, and asserts on `result.content` / `result.details` — never on the model's closing prose.

| Scenario | Prompt | Assertion |
| --- | --- | --- |
| `honesty` | run `bash` with exactly `false` | the last bash result has `details["outcome.v1"]` with `effectState: "unknown"` and `retry: "after-input-change"`, and its text contains `[outcome: error · effect unknown · retry after-input-change]` |
| `file` | `edit` `missing.txt`, replace `alpha` with `beta`, do not create it | the last failed file operation has `code: "NOT_FOUND"`, `effectState: "none"`, and the line `[outcome: error · effect none · retry after-input-change]` |
| `eval` | run `process.exit(3)` in a `js` cell | the last eval result has `code: "RESULT_UNKNOWN"`, `effectState: "unknown"`, `retry: "never"` |
| `dedup` | read `data.txt` twice, no other tool | at least two reads; the first contains `line 7 of the fixture`, the second contains `body already present in the current model context` and is strictly shorter |
| `ptc` | run `await ops.read({"path": "x"})` in a `py` cell without loading anything | at least one eval cell carries a `%load` hint, and that line names both helpers: `%load "<…>ops.mjs"` and `%load "<…>ops.py"` |

The scenarios are non-deterministic by nature — they depend on the model following a one-line
instruction. A green run proves the extension loaded, that the host delivered the payload, and that
the port reacted correctly; it is not a claim that every model will take the same path.

## Manual probe

When a behaviour is not covered by a scenario, probe a real session with the same shape:

```sh
omp -p --mode json -e /absolute/path/to/omp/src/extension/index.ts --max-time 180 "<prompt>"
```

`--mode json` emits `tool_execution_end` events whose `result` carries `content`, `details` and
`isError`, which is everything the assertions need. Use an absolute `-e` path — a relative one is
resolved against the probe's working directory. `--max-time` is seconds.

Do **not** pass `--no-tools=false` in the belief that it re-enables tools. On omp 18.12.6 the switch
is in effect whenever it is present: a probe on the prompt "Reply with the single word DONE."
reported 91 input tokens with the switch and 268 without, and a prompt that required `read`
produced no tool-execution events at all. The default (switch absent) has tools on; leave it alone.

## What a green run does not prove

- It does not measure tokens or latency against a baseline. The only size claims in these docs are
  wire-observed bytes: 1101 B for a fixture body, 173 B for its dedup reference, `matchCount` and
  `fileCount` values copied from host payloads.
- It does not prove that dedup always hits. Seven live probes produced six hits and one miss on the
  same shape; a miss returns the full body, which is the safe direction.
- It does not prove coverage for a paged `grep`: the port reports every such call `partial` because
  the host's 2000-match clip is invisible (see [host-defects.md](host-defects.md)).
