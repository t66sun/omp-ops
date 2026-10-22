# The omp port

[中文](README.zh.md)

`omp/` is a port of dsh-ops' load-bearing algorithms into an extension for the omp harness. It is
not a second plugin with a new tool set. It observes the host's `tool_result` event, edits what the
model sees when the host's own answer is misleading, and ships an SDK that lives inside `eval`.

The DSH plugin in `src/` is unchanged and keeps shipping on its own. `omp/` has no dependency on it
and no imports from it; deleting `omp/` leaves the DSH plugin intact.

## Why this exists

Three claims carry the port. Each one is small on its own; together they remove a class of failure
that costs more than any single tool.

1. **Honest feedback stops retry loops.** A failure that does not say whether it changed anything
   invites a blind replay — of a write, a command, an `eval` cell. Every classified failure
   publishes what it can prove: `effectState` (`none` / `applied` / `partial` / `unknown`) and a
   `retry` policy derived from it. Effects dominate: a failed call that may have written something
   never advises another attempt.
2. **Small schemas save tokens.** The extension registers no tools, no commands and no shortcuts,
   so it adds no tool-schema tokens and never changes the tool list. The resident cost is one
   `tool_result` handler and a few field readers.
3. **Progressive disclosure.** Nothing is announced up front. The outcome line appears only on a
   result that is not `completed`; the PTC hint appears only in a cell that reached for `ops`
   without loading it; dedup only replaces a body the model has already seen.

## What shipped

| Capability | The promise, in one line |
| --- | --- |
| Honest outcomes | Every classified failure says what it may have changed and whether a retry can help, in `details["outcome.v1"]`. |
| One model-visible line | A failed result gains exactly one `[outcome: <status> · effect <state> · retry <policy>] <message>` line; a successful result is byte-identical. |
| Read dedup | Re-reading an unchanged file returns a short reference line naming the tool call that already holds the body, instead of the body again. |
| PTC SDK | `await ops.read({…})` inside an `eval` cell returns the same typed `Outcome`, loaded with the host's `%load` because omp exposes no prelude API to extensions. |

The contracts behind the promises — field shapes, eligibility gates, byte caps, and the honest
limitations — are in [contract.md](contract.md). The host behaviours the port works around, with
reproductions and numbers, are in [host-defects.md](host-defects.md).

## Installing

The plugin package root is `omp/`, not the repository root. Its manifest is `package.json#omp`,
which points at `./src/extension/index.ts`.

That layout decides the install channel. **`omp plugin install <git-url>` does not work here.** The
command resolves the git URL to a package root, and this repository's root is the DSH plugin, not
the omp package; there is no subdirectory in the spec for it to descend into. The supported channel
is a marketplace catalog entry with a `git-subdir` source:

```json
{
  "name": "omp-ops",
  "source": {
    "source": "git-subdir",
    "url": "https://github.com/t66sun/omp-ops.git",
    "path": "omp",
    "ref": "main"
  }
}
```

Add that entry to the catalog your omp reads, then install `omp-ops` from it. The marketplace path
caches the source and symlinks it into `<scope>/plugins/node_modules`; it does not install
dependencies, which is why `omp/` stays dependency-free (its `package.json` declares none).

For local development, link the directory instead:

```sh
omp plugin link /absolute/path/to/repo/omp
```

## Status

| Round | Work | State | Why |
| --- | --- | --- | --- |
| 1 | Honesty layer: kernel rules, `outcome.v1`, one rendered line | Shipped | The core capability; every later round speaks its vocabulary. |
| 2 | Read/grep dedup with an evidence chain and epoch | Shipped | Pure output-layer change; no host cooperation needed. |
| 3 | PTC SDK (`ops`) plus `%load` helpers | Shipped | `tool.<name>` already exists inside `eval`; only the typed projection had to be built. |
| 4 | Native modules | None | Cancelled by the plan's own rule: a native module needs a reproducible failure first, and no candidate had one. grep coverage is derivable from the numbers already in `details`; strict CSV/TSV parsing is O(bytes) and TypeScript is enough below 32 MiB; document parsing is already covered by the host's own readers; the only possibly-native work (Windows DACL preservation, read-only refusal) had no observed failure. The plan's decision rule is "no failure scenario, no Round 4". |
| 5 | Table and batch tools (`ops_read_table`, plan/run/resume) | Not built | Optional in the plan, and it would add tools — exactly the schema cost this port avoids. Nothing in Rounds 1–3 depends on it, and the tree contains no `omp/src/table` or `omp/src/batch`. Strict CSV can be revisited if a real parse failure is observed. |
| 6 | Release: packaging, evidence, this documentation | This change | — |

## Evidence

- [spike-report.md](spike-report.md) — verbatim host payloads captured from omp 18.12.6.
- [prelude-findings.md](prelude-findings.md) — why there is no prelude API and what `%load` does.
- [testing.md](testing.md) — the gate, the five live scenarios, the unit suite, and the manual
  probe recipe.
