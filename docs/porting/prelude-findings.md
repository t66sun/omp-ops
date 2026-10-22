# Prelude findings — how `ops` reaches an `eval` cell

Observed on **omp 18.12.6** (`omp --version`). Answer: **there is no extension-facing prelude
registration.** The channel is host-owned; an extension cannot add a prelude, and the only surface
an extension can reach is the `eval` tool's `%load`, which runs a **script** (no ESM `export`).

`omp/src/ptc/prelude.ts` therefore reports `'load-file'` for a real host and publishes
`OPS_PRELUDE_PATH` (`<repo>/omp/src/ptc/js/ops.mjs`, absolute, resolved from `import.meta.url`).

## 1. What the shipped binary says

`omp.exe` is a Bun bundle with readable module source. Reading `preludes.ts` out of it:

- Preludes are composed inside `createAgentSession` only:
  `const Jh = () => { if (fn || !_t.has('eval') || !Ls.has('eval')) return []; ... if (eh.get(P)) xe.push(mse(ft)); ... return b0(xe) }`
  then `ft.getEvalPreludes = Jh` — four built-ins, each gated by its own setting handle. No list a
  caller can extend.
- `PreludeDefinition` (built-in shape) is `{name, documentation, guidance?, javascript, python, exports, approval?, enabled, invoke, status}`.
- The bundled browser definition is constructed by `createBrowserPreludeDefinition(settings, {invoke, status, relayFallback})`, i.e. the definition object is built by the host, not accepted from outside.
- `grep -a "registerEval" omp.exe` → **no hits**. There is no registrar name anywhere in the binary.
- The extension API exposes the prelude *factories* but no installation slot: `pi.pi` exports contain
  `createBrowserPrelude`, `createComputerPrelude` (probe below).

## 2. Probe runs

Throwaway package `C:/Users/Toshu/AppData/Local/Temp/omp-prelude-probe/` with
`package.json` (`{"omp":{"extensions":["./ext.ts"]}}`), `ext.ts`, `ext-b.ts`,
`fixture.mjs`, `fixture2.js`, `fixture3.js`. Run from that directory:

```
omp -p --no-session --auto-approve --no-lsp --max-time 180 -e ./ext.ts '<prompt>'
```

### 2a. Enumerate the extension API (`ext.ts` dumped `Object.keys(api)` to `api-keys.json`)

```
keys    : arktype, cwd, events, extension, flagValues, logger, pendingProviderRegistrations, pi, typebox, zod
proto   : on, registerTool, registerCommand, registerShortcut, registerFlag, registerMessageRenderer,
          registerAssistantThinkingRenderer, registerComposerShape, registerProvider, unregisterProvider,
          registerFileWriteFallback, registerFileDeleteFallback, setLabel, getFlag, sendMessage,
          sendUserMessage, appendEntry, exec, getActiveTools, getAllTools, getCommands, getSessionName,
          setSessionName, setModel, getThinkingLevel, setThinkingLevel, getServiceTiers, setServiceTier
matches : {}                       # no member matching /prelude/i, on the instance or its prototype
pi.pi   : [createBrowserPrelude, createComputerPrelude]   # factories, not an installer
```

Same run, cell 1 code `console.log("PROBE1", typeof ops, typeof browser)` printed
`PROBE1 undefined object` — the built-in `browser` prelude is installed, `ops` is not, and nothing an
extension does can make it so.

### 2b. Candidate registration shapes (`ext-b.ts`, one `try` per candidate, results logged)

| Candidate | Result |
|---|---|
| `pi.registerEvalPrelude({name:'ops', ...})` | `returned undefined` (member absent) |
| `pi.registerPrelude({name:'ops', ...})` | `returned undefined` (member absent) |
| `pi.registerEvalPreludes([...])` | `returned undefined` (member absent) |
| `pi.registerResource('eval/ops', {...})` | `returned undefined` (member absent) |
| `pi.extensionData.preludes = [...]` | `returned no extensionData` |
| module-level `export const preludes = [...]` | loaded, ignored — no effect |
| `package.json` `omp.preludes` + `preludes/ops.ts` via `omp plugin link` | plugin loaded, ignored |

Every `pi.<name>?.(...)` returning `undefined` is the absence of the method, not a refused call — the
dump in 2a shows the whole member list.

The plugin-`link` variant (`omp plugin link <dir>`, extension loaded — it wrote `ext-loaded.json`)
printed `LINKPROBE undefined undefined object`: `ops` undefined, the package's `preludes/ops.ts`
never ran, `browser` present. Then `omp plugin uninstall omp-prelude-probe-link` and the temp
directories were deleted (`omp plugin list` no longer shows the probe).

### 2c. `%load` — the fallback, and its one constraint

```
Cell: %load "C:/.../fixture2.js"          → (silent)
Cell: console.log("PROBE3", globalThis.__probe_loaded, typeof ops, ...)
     → PROBE3 omp-prelude-fixture undefined undefined undefined undefined undefined
```

`%load` installs the script into the live cell runtime and top-level declarations stay visible to
later cells (`%load fixture3.js` then `typeof fixtureFn, typeof fixtureConst, typeof fixtureVar` →
`function number number`). It does **not** create globals from module exports.

`%load` of ESM source fails — this is the constraint that matters for `js/ops.mjs`:

```
%load ".../fixture.mjs"   (contains `export const marker`) → SyntaxError: Unexpected keyword 'export' at <parse>
%load ".../statements.mjs" (no export, only statements)     → MJS string   (works)
%load ".../exports.js"     (contains `export const thing`)  → SyntaxError: Unexpected keyword 'export'
```

The failure follows the `export` keyword, not the file extension. A file destined for `%load` must be
script form (assign `globalThis.ops = ...`); an ESM module with `export` cannot be loaded that way.

## 3. Consequences for the slice

- `installPrelude(host)` answers `'prelude'` only if the host exposes `registerEvalPrelude` (absent in
  18.12.6; the check keeps the channel honest if a host ever grows one) and it accepts the definition
  `{name:'ops', exports:['ops'], module:<abs path>, documentation}`.
- Otherwise a real omp extension host gets `'load-file'` and the absolute `OPS_PRELUDE_PATH`.
- Anything else — a primitive, an empty object, a host that throws while inspected or a registrar that
  rejects — gets `'none'`; `installPrelude` never throws.
- The path is published, not checked: the `js/ops.mjs` file belongs to the JavaScript slice and does
  not exist in every worktree, so existence is the caller's fact, not the installation verdict.
- **Risk for the JavaScript slice:** `%load` cannot digest ESM `export`, so a script-form entry
  (globals, no `export`) is what the model can actually load today.
