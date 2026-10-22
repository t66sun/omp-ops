# Host behaviours we work around

[中文](host-defects.zh.md)

All of these were observed on omp 18.12.6 (`omp --version`). None is fixed by patching the host: the
port detects the shape and degrades to the honest answer. The reproductions and numbers are those
recorded in `restructuringPLAN.md` §5.4; the verbatim payloads are in
[spike-report.md](spike-report.md) and [prelude-findings.md](prelude-findings.md), and the numbers
below are copied from those captures.

## 1. grep's internal 2000-match clip

**What happens.** grep stops collecting after 2000 matches and returns the next page as if the scan
had reached the end of the tree. A page is capped at 20 files and 20 matches per file, so
`matchCount` tops out at 200 on a multi-file search and can never reach the 2000 that triggered the
stop. The cap therefore never appears in a count, a flag, or an error.

**Reproduction.** A tree of 300 files, `f000..f299`, each with 10 matching lines; search the
directory for the pattern.

| Call | `matchCount` | `fileCount` | `truncated` | Reality |
| --- | --- | --- | --- | --- |
| first page | 200 | 20 | `true` | page 0 of the scan |
| `skip: 199` | 10 | 1 | — | one file left on that page |
| `skip: 200` | 0 | 0 | `false` | `f200..f299` exist and match |

The empty page carries no limit key, so it is byte-for-byte the shape of "the tree has nothing
more". The trigger is the internal 2000: 300 files × 10 matches, and also 120 files × 40 matches,
which stops at 96 files. A tree with 300 files × 5 matches (1500 total) has no cap at all, which is
why the defect cannot be inferred from a file count.

**Workaround.** A call with `skip > 0` is never reported complete: the search rule emits
`status: 'partial'`, `truncatedBy: 'row-limit'`, and a message that states the observed page and
"total unknown". A first page is complete only when no truncation flag is set. No code path claims
a `matchedTotal` for a paged scan.

## 2. `read`'s `meta.truncation.totalBytes` is the output size

**What happens.** `details.truncation.totalBytes` (and the copy in
`details.meta.truncation.totalBytes`) is not the file's size. It is the number of bytes in the
emitted page.

**Reproduction.** Reading a ~61 KB file whose page was cut to the output budget reported
`totalBytes: 1577`, equal to `outputBytes`. In the captured paged read of `pipeline.ts:1-5`, the
payload is internally inconsistent in the same direction:

```json
{
  "truncation": { "truncated": true, "truncatedBy": "lines", "totalLines": 54,
                  "totalBytes": 147, "outputLines": 5, "outputBytes": 147 },
  "fileSize": 1703,
  "meta": { "truncation": { "direction": "head", "nextOffset": 6 } }
}
```

`totalLines: 54` is correct, `fileSize: 1703` is correct, and `totalBytes: 147` is exactly the five
lines that were shown.

**Workaround.** Continue a read with `details.meta.truncation.nextOffset`; never size a buffer or a
progress bar from `totalBytes`. Dedup never reads it either: a record is keyed by the `stat`
identity (`dev`, `ino`, `size`, `mtimeNs`, `ctimeNs`), not by the wire field.

## 3. grep's limit fields are numbers when hit and absent when not

**What happens.** `fileLimitReached` and `perFileLimitReached` are not booleans. When a limit is
hit, the host writes the limit value; when it is not, the key does not exist. A result that lands
exactly on a cap is *not* truncated: it reports `truncated: false` and omits both keys.

**Reproduction.** A ten-file result at the cap:

```json
{ "matchCount": 20, "fileCount": 10, "truncated": false }
```

Both limits hit (a common token over `src`):

```json
{ "matchCount": 379, "fileCount": 20, "truncated": true,
  "fileLimitReached": 20, "perFileLimitReached": 20 }
```

**Workaround.** Treat presence, or truthiness, as the signal; never compare with `true`, and never
read the value as a count. The search rule uses `Boolean(details[flag])` for all four flags
(`truncated`, `fileLimitReached`, `perFileLimitReached`, `linesTruncated`), and the dedup gates use
the same test.

## 4. `eval` timeouts carry no `exitCode`

**What happens.** An `eval` failure payload is
`{ language, languages, cells: [{ code, language, output, status, exitCode?, durationMs }], isError? }`.
A cell killed by its deadline has `durationMs` and a `[eval cell timed out …]` line but **no**
`exitCode`; the kernel-exit line appears in the same text. A JS worker exit arrives as
`Error: JS eval worker exited with code N`, and a dead kernel as
`[Kernel died during execution; completion is uncertain…]`.

**Reproduction.** Run a cell that outlives the deadline; inspect `details.cells[0]`. The absence of
`exitCode` is the normal timeout shape, not a sign that the cell succeeded.

**Workaround.** Classification is by ordered text sentinels, most specific first: `cell timed out`
before `eval worker exited with code` before `kernel died during execution` before
`[kernel] … exited with code`. The timeout must win, because its text also contains the kernel-exit
line. Every failure kind publishes `RESULT_UNKNOWN` with `effectState: 'unknown'` and
`retry: 'never'`: a cell can write a file on line 1 and throw on line 2. `exitCode` is never used
as evidence of success.

## 5. No extension-facing eval-prelude API

**What happens.** Preludes are composed inside `createAgentSession` from four built-in definitions,
each gated by a host setting. There is no registration slot an extension can reach:

- `grep -a "registerEval" omp.exe` returns no hits; the registrar name does not exist in the binary.
- The extension API has no member matching `/prelude/i` (checked on the instance and its prototype);
  probe output: `PROBE1 undefined object` — the built-in `browser` prelude is installed, `ops` is
  undefined.
- `pi.registerEvalPrelude(...)`, `pi.registerEvalPreludes([...])` and `pi.extensionData.preludes`
  are all absent; a module-level `export const preludes = [...]` and a package manifest's
  `omp.preludes` are loaded and ignored.

The one channel that does work is the `eval` tool's `%load`, which runs a **script** in the kernel
and rejects ESM syntax (`Unexpected keyword 'export' at <parse>`).

**Workaround.** `prelude.ts` returns `'load-file'` for a real host and publishes
`OPS_PRELUDE_PATH` as an absolute path resolved from `import.meta.url`. The JS helper is a script
(no imports, no exports, one `globalThis.createOps` at the end); the Python helper publishes
`create_ops`. The load hint is registered only for `'load-file'` and only appears after a failing
cell names the SDK, so a session that never uses PTC pays nothing.
