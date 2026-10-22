## Hard rules

1. **No code file over 1000 lines.** `node scripts/check-file-size.mjs` (`npm run check:size`) runs
   in CI over every git-tracked `.js .mjs .cjs .ts .mts .cts .rs .ps1 .sh .py .cpp .h .hpp .cc` file
   outside `node_modules/ native/target/ runtime/ licenses/ docs/ dist/`. When a file approaches the
   limit, split it into modules and group them in a folder (see `src/shells/`,
   `scripts/lib/build/`, `bench/lib/fixtures/`). Do not raise the limit or add exclusions.
2. **A PR adds at most ~1000 implementation lines** (tests and byte-identical moves excluded) and
   touches only the files its slice owns. Slices are defined in `restructuringPLAN.md`; parallel
   slices never share a file, so merge order does not affect correctness.
3. **No AI attribution** in commits, PRs, issues or comments: no `Co-authored-by:` lines naming an
   agent/model/bot, no "Generated with/Made with" footers. Commits use the user's own identity.
4. **Every new behaviour has an assertion** that fails when the change is reverted. No silent skips,
   no retries to hide flaky concurrency — fix the cause.
5. **Do not edit generated output.** `lib/` is built from `src/`; `runtime/` is staged worker output.

## Layout

| Path | Contents |
| --- | --- |
| `src/` | Plugin source (strict TypeScript and TSX). Compiled by `tsc` to `lib/` |
| `omp/` | The omp port (see `restructuringPLAN.md`). Zero dependency on `src/`; deletable without affecting the DSH plugin |
| `lib/` | Build output that is shipped and imported by tests — gitignored, never edited by hand |
| `src/components/<name>/` | One directory per DSH component row (`shell`, `file`, `ptc`, `panel`, `tui`, `hide-official`, …): entry, `package.json`, `locale/`, `icon.png` |
| `native/` | Rust worker (`dsh-ops-worker`); one JSON request on stdin, one JSON result on stdout, spawned per call through the host subprocess/sandbox |
| `test/` | One `*.test.mjs` file = one suite = one process; shared helpers in `test/lib/` (never named `*.test.mjs`) |
| `bench/` | Repository-only benchmarks; never shipped, never part of the default gate |
| `scripts/`, `bin/` | Gate, manifest validation, packaging, CLI |
| `docs/` | Bilingual docs: every document exists in English and Chinese |

- Suites without a built worker **skip**; a skip is not a pass. On Linux/macOS the gate sets
  `DSH_OPS_REQUIRE_RUNTIME=1`, which turns those skips into failures.
- `DSH_HOME` must point into the system temp directory when running a suite directly; the harness
  refuses anything else. `node test/run.mjs` creates one per suite.

## Code conventions

- English for code, comments, CLI output and commit messages; user-facing docs in both languages,
  updated in the same PR.
- Tool names always come from `publicToolName()` in `src/policy.ts`; never hand-write `ops_`.
- Config is validated in `src/config.ts`; unknown keys are errors that name the key. Defaults in
  `cordis.patch.yml` must equal the defaults in code.
- The host half must not import `@deepseek-ai/*` values at load time; use `ctx.inject` / `ctx.get`.
  Publish tools only through this plugin's own scoped `ctx.tools.register`.
- Tool failures are returned values (`status`, `error.code`, `effectState`), never thrown. Never
  report a partial or early-stopped result as complete.
- Do not remove tool contracts (argument semantics, defaults, path base, paging completeness,
  permission boundaries) to save schema bytes.
- New dependencies need a reason in the PR, an exact version published at least 7 days earlier, and
  no change to security settings.

## Commits and PRs

- Conventional, imperative English subjects, e.g. `fix(file): classify oversized grep files`.
- GitHub issues are disabled on this fork. A PR instead claims one row of the round table in
  `restructuringPLAN.md` and carries its own slice spec in the body: the owned file list, the
  assertions that must fail when the change is reverted, and the contract version it builds against.
- Merging is delegated to the assistant. `main` is protected against force-push and deletion, but
  requires no review, so a slice PR may be merged by its author once its assertions pass.
- Add a `docs/CHANGELOG.md` `## [Unreleased]` entry when behaviour or shipped docs change.

## Windows notes

- Run `npm`/`git` from PowerShell if the Git Bash environment resolves `npm` to WSL or lacks the git
  identity/CA bundle.
- `omp/` needs no build step and no Bun CLI: omp loads its `.ts` sources directly, and its tests run
  on Node's native type stripping — `node --test "omp/test/*.test.ts"`. **Quote the glob**: on Node 24
  the bare form resolves the directory and fails with `Cannot find module ...\omp\test`.
- `node scripts/check-slices.mjs` proves the parallel-slice invariant: no two PR-numbered commits
  touch the same file outside the frozen contracts, and every unnumbered commit that does is printed.
- `node omp/scripts/smoke.mjs` is the live gate: it starts real `omp -p` sessions with the extension
  loaded and asserts on the tool payloads the host emitted. It needs `omp` on `PATH` (or `OMP_BIN`),
  costs ~20 s, and unit tests never replace it — they run in-process and cannot see the host.
