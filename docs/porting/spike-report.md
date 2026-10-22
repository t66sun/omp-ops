# Spike report: what omp's `details` actually look like

Host: omp 18.12.6 (`C:\Users\Toshu\AppData\Roaming\npm\omp.exe`), run as `omp -p` from a throwaway
package in `%TEMP%` with a `.ts` extension linked by `omp plugin link`. The extension appended
`JSON.stringify(payload)` for every `tool_result` (and later for the other tool events) to a log
file; nothing else in the session was instrumented. Payloads below are copied out of that log
unchanged, except that multi-kilobyte `displayContent` strings are dropped where a guard never
reads them and each drop is marked.

Everything here is what `omp/test/guards.test.ts` asserts against.

## `bash`

Success (`echo`-style, exit 0). `details`:

```json
{ "wallTimeNoticeEmitted": false, "timeoutSeconds": 60, "wallTimeMs": 85.48440000000028 }
```

Proves: a successful command carries **no** `exitCode` key at all, so "0" is never on the wire and
absence must be read as success-or-unknown, not as a failure.

Non-zero exit (`echo out; exit 3`). `details`:

```json
{ "wallTimeNoticeEmitted": false, "timeoutSeconds": 60, "wallTimeMs": 76.60339999999997, "exitCode": 3 }
```

Content: `"out\n\n\nCommand exited with code 3"`. Proves: a failing command is an ordinary result
with `exitCode` set — it is *not* a denial, and the denial signal cannot be `isError`.

Timeout (`timeout: 3` on a command that ran past it). `details`:

```json
{ "wallTimeNoticeEmitted": true, "timeoutSeconds": 3, "wallTimeMs": 3157.6731, "timedOut": true }
```

Proves: a deadline that fires is reported in `details.timedOut`, with no `exitCode`.

Backgrounded instead of timing out (`sleep 5` with `timeout: 1`). `details`:

```json
{ "async": { "state": "running", "jobId": "bg_1", "type": "bash" }, "timeoutSeconds": 1 }
```

Proves: a short `timeout` can hand the command to the background-job manager rather than kill it, so
`timedOut` is not a proxy for "did not finish".

Refused before execution (`--approval-mode=always-ask`, no UI). No `details` key at all; content:

```
Tool "bash" requires approval but no interactive UI available.
Options:
  1. Set tools.approvalMode: yolo in /settings
  2. Add tools.approval.bash: allow to config
  3. Use an interactive UI to approve the tool call
```

Proves: denial is a *message-only* error result, distinguishable from a non-zero exit because it has
no `details` and says why. See the event section — the host does not even emit `tool_result` for it
on this path.

## `read`

Paged read of `omp/src/pipeline.ts:1-5` (output cut to five lines). `details`:

```json
{
  "truncation": { "truncated": true, "truncatedBy": "lines", "totalLines": 54, "totalBytes": 147,
                  "outputLines": 5, "outputBytes": 147, "lastLinePartial": false,
                  "firstLineExceedsLimit": false },
  "totalLines": 54,
  "rowPrefixes": false,
  "displayContent": { "startLine": 1, "lineNumbers": [1, 2, 3, 4, 5] },
  "fileSize": 1703,
  "meta": {
    "source": { "type": "path", "value": "C:\\c\\dev\\wt\\runtime\\omp\\src\\pipeline.ts" },
    "pagedSource": true,
    "truncation": { "direction": "head", "truncatedBy": "lines", "totalLines": 54, "totalBytes": 147,
                    "outputLines": 5, "outputBytes": 147, "maxBytes": 51200,
                    "shownRange": "<max-depth>", "nextOffset": 6 }
  }
}
```

(`displayContent.text` dropped: 147 bytes of source the guard never reads.) Proves: truncation is
explicit twice — a `details.truncation.truncated` boolean and a `meta.truncation` record — and the
absolute path lives at `meta.source.value`, not at `details.resolvedPath`.

Multi-target read of `omp/src/pipeline.ts:1-5;omp/src/host/contracts.ts:1-5`. `details`:

```json
{
  "notes": ["Note: interpreted as 2 paths: omp/src/pipeline.ts:1-5, omp/src/host/contracts.ts:1-5"],
  "displayReadTargets": ["omp/src/pipeline.ts:1-5", "omp/src/host/contracts.ts:1-5"],
  "displayReadTargetLinks": ["C:\\c\\dev\\wt\\runtime\\omp\\src\\pipeline.ts",
                             "C:\\c\\dev\\wt\\runtime\\omp\\src\\host\\contracts.ts"]
}
```

Proves: a multi-file read has no `meta` and no truncation record; the absolute, range-free paths are
in `displayReadTargetLinks`, and `displayReadTargets` still carries the `:1-5` suffixes.

Whole-file read of `omp/src/kernel/errors.ts` (3 KB `displayContent` dropped). `details`:

```json
{
  "totalLines": 64,
  "rowPrefixes": false,
  "fileSize": 3098,
  "meta": { "source": { "type": "path", "value": "C:\\c\\dev\\wt\\runtime\\omp\\src\\kernel\\errors.ts" },
            "pagedSource": true }
}
```

Proves: `pagedSource` is set even for an untruncated read, so it cannot be used as the truncation
flag; only the truncation records can.

## `grep`

Ten-file result exactly at the file cap (`grep` for `q` over `omp/src`), `displayContent` dropped.
`details`:

```json
{
  "scopePath": "omp/src",
  "searchPath": "C:\\c\\dev\\wt\\runtime\\omp\\src",
  "cwd": "C:\\c\\dev\\wt\\runtime",
  "matchCount": 20,
  "fileCount": 10,
  "files": ["omp/src/extension/index.ts", "omp/src/host/contracts.ts", "omp/src/pipeline.ts",
            "omp/src/render/index.ts", "omp/src/render/outcome-line.ts", "omp/src/rules/bash.ts",
            "omp/src/rules/eval.ts", "omp/src/rules/file.ts", "omp/src/rules/index.ts",
            "omp/src/rules/search.ts"],
  "fileMatches": [{ "path": "omp/src/extension/index.ts", "count": 4 }, "...one per file"],
  "truncated": false
}
```

Proves: being *at* a cap is not truncation; when nothing was cut the limit keys are simply absent.

Both limits hit (a very common token over `src`; `files`/`fileMatches`/`displayContent` dropped).
`details`:

```json
{
  "scopePath": "src",
  "searchPath": "C:\\c\\dev\\wt\\runtime\\src",
  "cwd": "C:\\c\\dev\\wt\\runtime",
  "matchCount": 379,
  "fileCount": 20,
  "truncated": true,
  "fileLimitReached": 20,
  "perFileLimitReached": 20
}
```

Proves: `fileLimitReached` and `perFileLimitReached` are **numbers, not booleans** — the host writes
the limit that was hit and omits the key otherwise, so presence is the flag and the rule layer must
not expect `true`.

Missing path (`path: "omp/src;nope-dir"`). `details` (content lists dropped):

```json
{
  "scopePath": "omp/src",
  "searchPath": "C:\\c\\dev\\wt\\runtime\\omp\\src",
  "cwd": "C:\\c\\dev\\wt\\runtime",
  "matchCount": 8,
  "fileCount": 2,
  "files": ["omp/src/kernel/errors.ts", "omp/src/pipeline.ts"],
  "truncated": false,
  "missingPaths": ["nope-dir"]
}
```

Proves: a search that still matched but skipped a path reports it as an array of path strings —
count, not set, is the useful fact.

No matches. `details`:

```json
{ "scopePath": "omp/src/kernel/errors.ts", "searchPath": "C:\\c\\dev\\wt\\runtime\\omp\\src\\kernel\\errors.ts",
  "cwd": "C:\\c\\dev\\wt\\runtime", "matchCount": 0, "fileCount": 0, "files": [], "truncated": false }
```

Proves: zero matches is a successful, fully-populated payload; no error path is involved.

## `glob` and `write` (contrast, for shape collisions)

`glob` `details` (paths dropped): `scopePath`, `fileCount: 200`, `files`, `truncated: true`,
`resultLimitReached: 200`, `cwd`, `meta` — **no** `matchCount`, so it cannot be mistaken for grep.

`write` `details`: `{ "resolvedPath": "C:/nonexistent-probe-root/nested/file.txt" }` — the same
key name `read` uses on its failure path, which is why the guards are gated on the tool name.

## Event arity and the second argument

Every handler registered with `api.on(event, handler)` is called with **two** arguments:
`(payload, ctx)`.

- `tool_result` payload keys: `["type", "toolName", "toolCallId", "input", "content", "details", "isError"]`.
  Note `input`, not `args` — `observe()` already reads that name.
- `ctx` own keys: `["ui"]`. Nothing else. **No session or agent identifier is on `ctx`.**
- `tool_execution_end` payload keys: `["type", "toolCallId", "toolName", "result", "isError"]`, where
  `result` is `{ content, details, isError }` — the same triple a transform sees.

## Session identity (the dedup blocker)

There is no session or agent id in the `tool_result` payload or in `ctx`. What *is* reachable, all
observed in a live session:

| Source | Value observed |
| --- | --- |
| `process.env.PI_SESSION_ID` | `01a16428-05fe-76c5-a29c-fae5a57a0941` (env is process-wide, readable from extension scope) |
| `process.env.PI_SESSION_FILE` | present |
| `tool_approval_requested` / `tool_approval_resolved` payload | `sessionId: "01a16434-67fa-73dc-b6b8-5b2b6d57e3dd"` |
| `api.getSessionName()` | `undefined` in `-p` (a name, not an id; only set if the user names the session) |
| agent id | not found; `PI_AGENT_ID` is unset and no API exposes it |

Answer: key dedup state on `process.env.PI_SESSION_ID`. It is stable for a session, needs no event
plumbing, and is the only identifier the host hands out on every path. Agent-level identity is not
available; if subagents share the process env, the coordinator will see one key for all of them.

## Hooks a rule layer can rely on (and one it cannot)

- Mutating `payload.details` inside a `tool_result` handler is visible to later handlers, and the
  mutated `details` object is what lands in `tool_execution_end.result.details`.
- Rewriting `payload.content` is what the model sees: a `read` result replaced with
  `[REWRITTEN BY PROBE]` was quoted back verbatim by the model, and a subsequent `edit` using a
  literal from the *original* text still succeeded — so a content rewrite does not trip the
  seen-lines check.
- There is no `api.registerEvalPrelude` (typeof `undefined`), but omp's own eval prelude already
  supports `%load "<path>"`: a helper file defining a global ran and the global was readable
  afterwards.
- **A denied tool call emits no `tool_result` at all.** The always-ask run produced
  `tool_execution_start` → `tool_approval_requested` → `tool_approval_resolved` (`approved: false`,
  `reason: "no interactive UI available"`) → `tool_execution_end`, and nothing else. A `denied`
  fact therefore has to be read from `tool_execution_end` (or the approval events), and the message
  form in `bashFacts` covers observations built from that event.

## Not triggered

A genuine mid-flight cancellation (`[Command aborted]` / `[Command cancelled]`) was not reproduced:
it needs an interruptible interactive session, and killing a `-p` run leaves no `tool_result` to
observe. The strings come from the host's cancellation path, where the command raises instead of
returning details, which is exactly the details-less branch `bashFacts` classifies as `aborted`.
The `tool_error`, `tool_timeout` and `tool_aborted` event names exist in the host, but none fired for
a non-zero exit, a timeout or a denial, so nothing here depends on them.
