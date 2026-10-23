# Consumer contract

[中文](contract.zh.md)

This page states what a consumer may rely on. It describes the shipped code, not an intention:
every shape below is in `omp/src/` and pinned by a test. Anything not written here is an
implementation detail that may change.

## 1. The `Outcome` shape

`omp/src/kernel/outcome.ts` defines the vocabulary. Every value is one of four effect states and
one of four retry policies:

```ts
type EffectState = 'none' | 'applied' | 'partial' | 'unknown'
type RetryPolicy = 'never' | 'after-input-change' | 'after-state-change' | 'bounded-transient'
type FailureStatus = 'rejected' | 'conflict' | 'error' | 'unknown'

interface OpsErrorPayload {
  code: string
  effectState: EffectState
  retry: RetryPolicy
  message: string
  nextAction?: string
}

type Outcome<T> =
  | { status: 'completed'; data: T; coverage?: CoverageMeta & { isComplete: true } }
  | { status: 'partial'; data: T; coverage: CoverageMeta & { isComplete: false }; continuation: string }
  | { status: FailureStatus; error: OpsErrorPayload; data?: T }
```

A `partial` result always carries a `coverage` record with `isComplete: false` and a
`continuation` string; a `completed` result's coverage, when present, is narrowed to
`isComplete: true` so a consumer cannot read a complete result as partial. `CoverageMeta` is
`{ scannedFiles?, matchedCount, isComplete, truncatedBy? }`, where `truncatedBy` is one of
`scan-budget`, `output-budget`, `time-limit`, `row-limit`.

`scannedFiles` is **absent** whenever the host does not report how many files it examined, which is
always for `grep`: omp publishes the files that matched (`fileCount`), not the files scanned, so the
field is omitted rather than filled with `fileCount` or with `0`. Absence is the honest statement —
a consumer that reads a missing count as zero would report "searched nothing" about a search that
found matches.

### Effects dominate retry advice

`errorPolicy(code, effectState)` is the only place that turns a failure into advice:

```ts
if (effectState === 'unknown' || code === 'RESULT_UNKNOWN' || code === 'EXECUTION_RESTRICTED') return unknown
if (effectState !== 'none') return settled
return ERROR_POLICIES[code] ?? settled
```

So a call that may have changed something never advises repeating it: `unknown` maps to
`status: 'unknown'`, `retry: 'never'`, and any other non-`none` effect maps to
`status: 'error'`, `retry: 'never'`. Only a proven `effectState: 'none'` consults the code table.

One deliberate exception exists, and only on the Bash failure payload: a command that ran to
completion and exited nonzero keeps `effectState: 'unknown'` (a write may have landed) but reports
`retry: 'after-input-change'`, because the exit code and output are evidence the model can read
before deciding. `errorPolicy('EXIT_CODE', 'unknown')` itself still answers `unknown`/`never`; the
exception lives in the producer, not in the rule. Inspecting output is not replaying the command.

## 2. Published facts and the rendered line

Rules write one frozen record under `details["outcome.v1"]`:

```ts
interface OutcomeFacts {
  status: 'completed' | 'partial' | 'rejected' | 'conflict' | 'error' | 'unknown'
  effectState: EffectState
  retry: RetryPolicy
  message: string
  code?: string
  nextAction?: string
  coverage?: CoverageMeta
}
```

`v1` is part of the key: a later shape must arrive under a new key, so an older renderer keeps
working and "no opinion" stays distinguishable from "an opinion I do not understand". Reading is
strict — a record missing one of `status`, `effectState`, `retry`, `message` is treated as absent,
not as a half-understood outcome.

The renderer (`omp/src/render/outcome-line.ts`) turns those facts into exactly one line, appended to
the last text block of the result:

```
[outcome: <status> · effect <state> · retry <policy>] <message>
```

If `nextAction` is present, ` Next: <nextAction>` is appended to the same line. The guarantees:

- **Only failures get a line.** `status: 'completed'` produces nothing; a successful result is
  byte-identical to what the host produced.
- **Exactly one line.** A second pass over the same result appends nothing; the line is matched
  verbatim at the end of the block.
- **One text block is touched.** If the result carries no text block (images only, an empty array),
  nothing is invented.
- **The block is replaced, not mutated,** because the extension detects changed content by identity.

Every transform is total: it may not throw, may not add content in any other transform, and may not
flip `isError`. A throwing transform is caught, recorded by name, and leaves the result as the host
produced it.

## 3. Read dedup

Dedup is a pure output-layer operation. It replaces the one text block of an eligible result; it
never writes `details` and never changes `isError`.

### Eligibility

`read` is eligible only when all of these hold:

- the call succeeded (`isError` is false) and the result is exactly one text block;
- the body does not contain `TruncatedBy: output-budget` (a cut body is a prefix, not the file);
- `details.meta.source` is `{ type: 'path', value: <absolute path> }`;
- `stat` says the path is a regular file, and the identity (`dev`, `ino`, `size`, `mtimeNs`,
  `ctimeNs`) can be read;
- the key — a JSON tuple of the tool name, the raw arguments, and that identity — can be
  serialised.

`grep` is eligible only when:

- the result is exactly one text block, and it is neither `No matches found` nor a
  `No more results` continuation;
- `details.matchCount` and `details.fileCount` are both numbers, and `fileCount > 0`;
- none of `truncated`, `fileLimitReached`, `perFileLimitReached`, `linesTruncated` is truthy
  (presence matters; the limit fields are numbers when hit and absent when not);
- `skip` is absent or `<= 0` — a paged call is never the first page;
- a revision (SHA-256 of the body text) can be computed.

### Validity and the caps

A record is keyed by agent key, context epoch and candidate key. The store is bounded:

| Limit | Value |
| --- | --- |
| Agents | 16 |
| Records per agent | 32 |
| Body bytes, store-wide | 2 MiB |

The oldest record is evicted when a cap is hit. Without an agent key (`agent:<id>` from the host
context, else `session:<PI_SESSION_ID>`), dedup does nothing: an unkeyed record is a claim about a
context we cannot identify.

A recorded body stays valid until:

- a successful `edit`, `write` or `bash` call forgets every record for that agent;
- the context epoch moves — `session_before_compact`, `session_compact`, `session_before_switch`
  or `session_before_branch` — because the model's context is no longer the one the body was
  recorded in;
- an identity proof fails, in which case the record stays a miss rather than being refreshed.

A hit rewrites only when the compacted form is strictly shorter than the body, and names the call
that actually carries the body. The shape depends on how the host renders a read, and both shapes are
supported because getting this wrong is silent:

- A **numbered** body (`12 | code`) loses its numbered lines and keeps the unnumbered framing.
- An **unnumbered** body — what omp's `read` actually emits: the file's own text, no `N |` prefix, no
  `[path#TAG]` header — has nothing to strip, so the body is dropped and only a subject line plus the
  reference remain. The subject is what keeps the notice actionable:

```
read omp/src/kernel/errors.ts
[Notice: Unchanged file range; body already present in the current model context in tool call "<id>". Fresh read revalidated the revision above.]
```

A body that already carries the reference line is never rewritten again, so a second hit cannot strip
the surviving framing.

Live measurement: the first read of a 40-line plain fixture returns ~1.1 KB; the second returns the
subject plus the reference line. Seven live observations included one miss that returned the full body
again, which is the designed failure direction — a miss costs bytes, never correctness.

Live measurement: the first read of the fixture returned 1101 B; the second returned 173 B. Seven
live observations included one miss that returned the full 1101 B again, which is the designed
failure direction — a miss costs bytes, never correctness.

## 4. The PTC SDK

`omp/src/ptc/` exposes eight host tools as one typed surface:

```ts
type OpsTool = 'read' | 'write' | 'edit' | 'glob' | 'grep' | 'bash' | 'eval' | 'task'
type Ops = { readonly [K in OpsTool]: (args: CanonicalData) => Promise<Outcome<CanonicalData>> }
```

`CanonicalData` is a JSON object. The projection reads `details["outcome.v1"]` first; the raw
payload is consulted only when there are no facts at all. Rules:

- a count is a non-negative safe integer; anything else (`NaN`, `-1`, `1.5`, `'7'`, a missing
  field) reads as `0`, because an unreadable count is not an approximation of a count;
- a truncation spelled `time` (the search report's spelling) is normalised to `time-limit`;
- a failure with no facts becomes `RESULT_UNKNOWN` / `effectState: 'unknown'` / `retry: 'never'`,
  never a guessed success;
- a `partial` result with no safe continuation gets an explicit message instead of a fabricated
  cursor.

### Loading it

omp 18.12.6 has no extension-facing prelude API, so the SDK cannot be injected. The channel is the
`eval` tool's `%load`, which runs a script in the kernel. The extension registers the load hint only
when the host answers `'load-file'`; on a host with a real registrar the hint is never registered.

JavaScript:

```
%load "<abs>/omp/src/ptc/js/ops.mjs"
const ops = createOps((name, args) => tool[name](args))
const out = await ops.read({ path: 'data.txt' })
```

The file is a script on purpose. `%load` rejects a module `export` (`Unexpected keyword 'export' at
<parse>`), so the helper has no `import` and no `export`; it publishes one name,
`globalThis.createOps`, at the end. It is plain JavaScript because the Bun worker cannot load the
project's TypeScript.

Python:

```
%load "<abs>/omp/src/ptc/py/ops.py"
ops = create_ops(tool)
out = await ops.read({"path": "data.txt"})
```

`create_ops(await_tool)` takes the call site as a callable and imports nothing. Both helpers are
handed the bridge; neither reaches for the host itself.

The hint is one line, appended to a failing `eval` result that names `ops`, `createOps` or
`create_ops` without containing `%load`. It names both absolute paths, and is not repeated in the
same transcript.

## 5. Limitations

These are properties of the host and of the design, not bugs to be fixed silently. A consumer must
plan around them.

1. **Dedup keys include the raw arguments.** `notes.txt` and `./notes.txt` are different keys, so a
   file reached by a differently spelled path is a safe miss: the full body is returned again. This
   is deliberate — normalising paths or ranges would make distinct line ranges collide, and a miss
   costs only bytes. The one observed miss in seven live probes was this shape and was not
   reproducible.
2. **A denied call produces no `tool_result` at all.** On the approval path the host emits
   `tool_execution_start`/`tool_execution_end` and an approval event, but no result payload. The
   extension therefore has no facts and renders no line for a denial; a `denied` fact can only be
   produced on the `tool_execution_end` path, which this port does not handle.
3. **A paged grep is never reported complete.** The host stops collecting at an internal 2000
   matches and can return an empty page that looks clean (see [host-defects.md](host-defects.md)).
   Since the cap is invisible, `skip > 0` is always reported as `partial` with
   `truncatedBy: 'row-limit'` — even when that page happens to be the last one. Complete coverage is
   only claimed for a first page with no truncation flag.

4. **There is one extension entry, and enabling a feature is installing the plugin.** Two host facts
   force this. Every extension entry gets its own module graph, so two entries that import the same file
   each get their own copy and module-level state does not cross entries — measured, an entry that
   imported the honesty barrel registered five transforms while a sibling entry's handler still saw an
   empty registry. And a marketplace install reads `omp.extensions` only: `omp.features` selects files
   for an npm/link install, but the published path never looks at it, so per-feature entries install and
   then load nothing. The features are therefore all wired from `src/extension/index.ts`, and the
   `features` block is deliberately absent rather than present as a switch that selects no files.

Two smaller ones, stated so they are not discovered later: only failures are classified, so a
successful file read carries no `outcome.v1` facts; and `read`'s success path is dedup's business,
not the honesty layer's.
