#!/usr/bin/env node
/**
 * The round gate (restructuringPLAN.md §5.6). Run before declaring any round done.
 *
 * Each step answers a question a reviewer cannot answer by reading a diff:
 *
 *   1. size     does any file break the 1000-line rule?
 *   2. unit     does every transform still pass its own assertions?
 *   3. stubs    is any slice still a `STUB — replaced by slice …` no-op?
 *   4. inert    is any transform registered with an empty body (silently doing nothing)?
 *   5. slices   did any two slices ever touch the same file?
 *   6. live     does a real omp session see the result? (needs `omp` on PATH)
 *
 *   node scripts/round-gate.mjs            # everything
 *   node scripts/round-gate.mjs --no-live  # skip the live step on a machine without omp
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const steps = []
const skipLive = process.argv.includes('--no-live')

function run(name, command, args) {
  const started = Date.now()
  try {
    const output = execFileSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: 'pipe' })
    steps.push({ name, ok: true, ms: Date.now() - started, output })
  } catch (error) {
    steps.push({ name, ok: false, ms: Date.now() - started, output: `${error.stdout ?? ''}${error.stderr ?? ''}` })
  }
}

run('size', 'node', ['scripts/check-file-size.mjs'])
run('plugin', 'node', ['scripts/check-omp.mjs'])
run('unit', 'node', ['--test', 'omp/test/*.test.ts'])
run('slices', 'node', ['scripts/check-slices.mjs'])

/** Every `.ts` under `dir`, recursively. */
function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return path.endsWith('.ts') ? [path] : []
  })
}

// 3. A stub that survived its slice is a feature that silently does nothing.
const stubs = sources('omp/src').filter((path) => readFileSync(path, 'utf8').includes('STUB — replaced by slice'))
steps.push({
  name: 'stubs',
  ok: stubs.length === 0,
  ms: 0,
  output: stubs.length === 0 ? 'no slice stub remains' : stubs.map((path) => `unreplaced stub: ${path}`).join('\n'),
})

// 4. An empty `apply` passes every type check and every "does not throw" test, so
//    it is checked structurally: a rooted transform must contain a real body.
const inert = sources('omp/src')
  .filter((path) => /(?:rules|render|dedup)\//.test(path.replaceAll('\\', '/')))
  .filter((path) => /apply\s*\(\s*[^)]*\)\s*\{\s*\}/.test(readFileSync(path, 'utf8')))
steps.push({
  name: 'inert',
  ok: inert.length === 0,
  ms: 0,
  output: inert.length === 0 ? 'every transform has a body' : inert.map((path) => `empty apply: ${path}`).join('\n'),
})

if (!skipLive) run('live', 'node', ['omp/scripts/smoke.mjs'])

let failed = 0
for (const step of steps) {
  const mark = step.ok ? 'ok  ' : 'FAIL'
  const seconds = (step.ms / 1000).toFixed(1)
  console.log(`${mark} ${step.name.padEnd(6)} ${seconds}s`)
  if (step.ok) continue
  failed += 1
  for (const line of String(step.output).trim().split('\n')) console.log(`     ${line}`)
}

if (failed > 0) {
  console.log(`\nround gate failed: ${failed} of ${steps.length} step(s)`)
  process.exit(1)
}
console.log(`\nround gate passed: ${steps.length} step(s)`)
