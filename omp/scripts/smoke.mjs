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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const EXTENSION = resolve(import.meta.dirname, '..', 'src', 'extension', 'index.ts')
const OMP = process.env.OMP_BIN ?? 'omp'
const MAX_TIME = process.env.SMOKE_MAX_TIME ?? '180'

function session(prompt, files) {
  const dir = mkdtempSync(join(tmpdir(), 'omp-ops-smoke-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  const run = spawnSync(OMP, ['-p', '--mode', 'json', '-e', EXTENSION, '--max-time', MAX_TIME, prompt], {
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

  /** Reading the same unchanged file twice must not re-send the body. */
  dedup(events) {
    const body = Array.from({ length: 40 }, (_, i) => `${i + 1} | line ${i + 1} of the fixture`).join('\n')
    const reads = executions(events).filter((e) => e.tool === 'read')
    if (reads.length < 2) return [`the model read ${reads.length} time(s), expected 2`]
    const problems = []
    if (!reads[0].content.includes('line 7 of the fixture')) problems.push('the first read did not return the body')
    if (!reads[1].content.includes('body already present in the current model context')) {
      problems.push(`the second read was not rewritten: ${JSON.stringify(reads[1].content.slice(0, 200))}`)
    }
    if (reads[1].content.length >= reads[0].content.length) problems.push('the rewritten read is not shorter')
    return problems
  },
}

const prompts = {
  honesty: 'Use the bash tool to run exactly this command: false    Then reply DONE.',
  dedup: 'Read data.txt, then read data.txt a second time. Do not use any other tool. Then reply DONE.',
}

const files = { 'data.txt': Array.from({ length: 40 }, (_, i) => `${i + 1} | line ${i + 1} of the fixture`).join('\n') }
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
