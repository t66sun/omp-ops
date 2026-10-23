#!/usr/bin/env node
/**
 * Live-session gate for the omp port.
 *
 * Unit tests prove each transform in isolation; this proves the host actually
 * loads the extension and that the model sees the result. Nothing here is
 * deterministic by nature, so every scenario asserts on the tool payload the
 * host emitted — not on model prose.
 *
 *   node omp/scripts/smoke.mjs             # every scenario
 *   node omp/scripts/smoke.mjs honesty     # one scenario
 *
 * OMP_BIN overrides the binary (default: `omp` on PATH).
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/**
 * The entries to load, read from the manifest rather than hardcoded: the base entry plus every feature
 * entry. `pkg[honesty]` is a *file selector*, so a wrongly spelled path here is exactly the failure this
 * gate exists to catch — a name that does not resolve loads nothing and the scenario sees no outcome.
 */
function entries() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const declared = [...(manifest.omp?.extensions ?? [])]
  for (const feature of Object.values(manifest.omp?.features ?? {})) {
    for (const entry of feature?.extensions ?? []) declared.push(entry)
  }
  return declared.map((entry) => resolve(ROOT, entry))
}

const EXTENSIONS = entries()
const OMP = process.env.OMP_BIN ?? 'omp'
const MAX_TIME = process.env.SMOKE_MAX_TIME ?? '180'

function session(prompt, files) {
  const dir = mkdtempSync(join(tmpdir(), 'omp-ops-smoke-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  const flags = EXTENSIONS.flatMap((entry) => ['-e', entry])
  const run = spawnSync(OMP, ['-p', '--mode', 'json', ...flags, '--max-time', MAX_TIME, prompt], {
    cwd: dir, encoding: 'utf8', timeout: 900_000,
  })
  rmSync(dir, { recursive: true, force: true })
  if (run.error) throw run.error
  const events = []
  for (const line of (run.stdout ?? '').split('\n')) {
    if (!line) continue
    try { events.push(JSON.parse(line)) } catch { /* a non-JSON line is not an event */ }
  }
  return events
}

/** Every completed tool call, in order, with the payload the model received. */
function executions(events) {
  return events
    .filter((e) => e.type === 'tool_execution_end' && e.result)
    .map((e) => ({
      tool: e.toolName ?? e.result.toolName,
      content: (e.result.content ?? []).map((b) => (b.type === 'text' ? b.text : `<${b.type}>`)).join(''),
      details: e.result.details ?? {},
      isError: e.result.isError === true,
    }))
}

const scenarios = {
  /** A failing shell command must carry an honest effect/retry line. */
  honesty(events) {
    const bash = executions(events).filter((e) => e.tool === 'bash')
    if (bash.length === 0) return ['the model never called bash']
    const last = bash.at(-1)
    const problems = []
    const facts = last.details['outcome.v1']
    if (!facts) problems.push('details["outcome.v1"] is missing')
    else {
      if (facts.effectState !== 'unknown') problems.push(`effectState is ${JSON.stringify(facts.effectState)}, expected "unknown"`)
      if (facts.retry !== 'after-input-change') problems.push(`retry is ${JSON.stringify(facts.retry)}, expected "after-input-change"`)
    }
    if (!/\[outcome: error · effect unknown · retry after-input-change\]/.test(last.content)) {
      problems.push(`content has no outcome line: ${JSON.stringify(last.content.slice(-200))}`)
    }
    return problems
  },

  /**
   * A caller that reaches for the SDK before loading it must be told how to load it. This is the one
   * capability a model cannot discover by trial: `%load` is a host channel, not a tool.
   */
  ptc(events) {
    const cells = executions(events).filter((e) => e.tool === 'eval')
    if (cells.length === 0) return ['the model never used eval']
    const hinted = cells.filter((e) => e.content.includes('%load'))
    if (hinted.length === 0) {
      return [`no eval cell carried the load hint; last cell: ${JSON.stringify(cells.at(-1).content.slice(-300))}`]
    }
    const line = hinted[0].content.split('\n').find((l) => l.includes('%load'))
    if (!/%load "[^"]+ops\.mjs"/.test(line ?? '')) return [`the hint does not name the JS helper: ${JSON.stringify(line)}`]
    if (!/%load "[^"]+ops\.py"/.test(line ?? '')) return [`the hint does not name the Python helper: ${JSON.stringify(line)}`]
    // Two entries registered a handler and both patched this one result: the outcome line comes from the
    // honesty entry, the hint from the ptc entry. Asserting both, in that order, is the only assertion
    // that proves the host chains handlers instead of letting the later one overwrite the earlier.
    const body = hinted[0].content
    const outcomeAt = body.indexOf('[outcome: ')
    const loadAt = body.indexOf('%load')
    if (outcomeAt === -1) return [`the ptc entry overwrote the honesty entry's outcome line: ${JSON.stringify(body.slice(-300))}`]
    if (loadAt < outcomeAt) return [`the hint landed before the outcome line, so the later handler did not see the earlier one: ${JSON.stringify(body.slice(-300))}`]
    return []
  },

  /** A failed file operation must say what it proves, not just that it failed. */
  file(events) {
    const failed = executions(events).filter((e) => e.isError && ['read', 'edit', 'write'].includes(e.tool))
    if (failed.length === 0) return ['the model never attempted a file operation on a missing path']
    const last = failed.at(-1)
    const facts = last.details['outcome.v1']
    if (!facts) return [`details["outcome.v1"] is missing on the failed ${last.tool}`]
    const problems = []
    if (facts.code !== 'NOT_FOUND') problems.push(`code is ${JSON.stringify(facts.code)}, expected "NOT_FOUND"`)
    if (facts.effectState !== 'none') problems.push(`effectState is ${JSON.stringify(facts.effectState)}, expected "none"`)
    if (!/\[outcome: error · effect none · retry after-input-change\]/.test(last.content)) {
      problems.push(`content has no outcome line: ${JSON.stringify(last.content.slice(-200))}`)
    }
    return problems
  },

  /** A dead kernel must never be reported as a clean run. */
  eval(events) {
    const ran = executions(events).filter((e) => e.tool === 'eval')
    if (ran.length === 0) return ['the model never used eval']
    const last = ran.at(-1)
    const facts = last.details['outcome.v1']
    if (!facts) return ['details["outcome.v1"] is missing on the eval result']
    const problems = []
    if (facts.code !== 'RESULT_UNKNOWN') problems.push(`code is ${JSON.stringify(facts.code)}, expected "RESULT_UNKNOWN"`)
    if (facts.effectState !== 'unknown') problems.push(`effectState is ${JSON.stringify(facts.effectState)}, expected "unknown"`)
    if (facts.retry !== 'never') problems.push(`retry is ${JSON.stringify(facts.retry)}, expected "never"`)
    return problems
  },

  /** Reading the same unchanged file twice must not re-send the body. */
  dedup(events) {
    const reads = executions(events).filter((e) => e.tool === 'read')
    if (reads.length < 2) return [`the model read ${reads.length} time(s), expected 2`]
    const problems = []
    if (!reads[0].content.includes('line 7 of the fixture')) problems.push('the first read did not return the body')
    if (!reads[1].content.includes('body already present in the current model context')) {
      problems.push(`the second read was not rewritten: ${JSON.stringify(reads[1].content.slice(0, 200))}`)
    }
    if (reads[1].content.length >= reads[0].content.length) problems.push('the rewritten read is not shorter')
    if (!reads[1].content.includes('read data.txt')) problems.push('the rewrite does not name the file it replaced')
    if (reads[1].content.includes('line 7 of the fixture')) problems.push('the rewrite re-sent the body')
    return problems
  },
}

const prompts = {
  eval: 'Use the eval tool with language js to run process.exit(3) and nothing else. Then reply DONE.',
  // Stated as a mandatory action, not a goal: "do not create the file" alone let the model decide
  // there was nothing to edit and answer without calling anything, which is not the behaviour under
  // test. The scenario proves what a failed edit reports, so an attempt must be required.
  file: 'Call the edit tool exactly once with path missing.txt, old_string alpha, new_string beta, even though that file does not exist. Never create it, never ask a question, never explain first. After the call fails, reply DONE.',
  honesty: 'Use the bash tool to run exactly this command: false    Then reply DONE.',
  dedup: 'Read data.txt, then read data.txt a second time. Do not use any other tool. Then reply DONE.',
  ptc: 'Use the eval tool with language py to run exactly this code and nothing else: await ops.read({"path": "x"})    Do not load anything first. Then reply DONE.',
}

// Plain prose on purpose: omp's `read` emits the file's own text with no `N |` prefix, so a numbered
// fixture would let the rewrite pass by stripping lines the host never sent. This is the shape the
// model actually receives, which is the only fixture that can prove the rewrite works.
const files = {
  'data.txt': Array.from({ length: 40 }, (_, i) => `line ${i + 1} of the fixture`).join('\n'),
}
let scenarioEvents = {}

const only = process.argv[2]
const names = only ? [only] : Object.keys(scenarios)
if (only && !scenarios[only]) {
  console.error(`unknown scenario ${JSON.stringify(only)}; known: ${Object.keys(scenarios).join(', ')}`)
  process.exit(2)
}

let failed = 0
for (const name of names) {
  process.stdout.write(`smoke: ${name} ... `)
  scenarioEvents[name] = session(prompts[name], files)
  const problems = scenarios[name](scenarioEvents[name])
  if (problems.length === 0) { console.log('ok'); continue }
  failed += 1
  console.log('FAILED')
  for (const problem of problems) console.log(`  - ${problem}`)
}

if (failed) {
  console.log(`\n${failed} of ${names.length} scenario(s) failed`)
  process.exit(1)
}
console.log(`\n${names.length} scenario(s) passed`)
