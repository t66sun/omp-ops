#!/usr/bin/env node
/**
 * Release gate for the omp plugin (restructuringPLAN.md §5.3, Round 6, slice `release/gate`).
 *
 * `scripts/round-gate.mjs` answers "did this round pass its own assertions?". This answers the
 * question a marketplace install asks: "is this tree shippable as an omp plugin?" It is static,
 * deterministic and offline: no session, no network, no model.
 *
 * Five checks, one line per violation, non-zero exit when any check fails:
 *
 *   manifest      omp/package.json is installable: real version, resolvable extension entries,
 *                 no dependencies (marketplace only caches and symlinks a plugin, it never runs
 *                 an install for it), feature names the runtime knows.
 *   reachable     every module under omp/src is imported by the extension or by a test. A file
 *                 nothing imports is either dead or unwired, and it still ships.
 *   hygiene       no console/process/debugger/leftover-marker in the shipped source.
 *   runtime-deps  the runtime imports only `node:` builtins and relative files.
 *   provenance    no AI attribution and no emoji in the shipped source.
 *
 * Reachability has two roots: the manifest's extension entries, and every `*.test.ts` under
 * omp/test. The second root is deliberate. Part of the port's surface is executed by the suite
 * rather than by the extension: `omp/src/ptc/outcome.ts` is the reference implementation the JS
 * and Python helpers are parity-tested against, and the PTC barrel is code-facing. A module
 * imported by neither root still fails; modules only the tests reach are reported as
 * `info unreachable-from-extension` instead of failing, because deleting a tested reference
 * implementation would be the wrong fix.
 *
 * Run from anywhere: `node scripts/check-omp.mjs`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const omp = join(root, 'omp')
const src = join(omp, 'src')
const tests = join(omp, 'test')

/** The runtime feature flags. Kept literal: importing pipeline.ts would make this a consumer. */
const FEATURES = ['honesty', 'dedup', 'ptc']
/** The only keys the loader reads out of a feature record. */
const FEATURE_KEYS = ['default', 'extensions', 'tools', 'hooks', 'commands', 'skills', 'mcpServers']

const MODULE = /\.(?:ts|mts|cts|js|mjs|cjs)$/
const TEXT = /\.(?:ts|mts|cts|js|mjs|cjs|py|json|md|txt)$/
// Anchored to statement lines on purpose: prose and test fixtures contain `from '...'` too
// (`indistinguishable from "..."`, a source sample passed to `new Script`), and neither is an edge.
const IMPORT_FROM = /^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/
const IMPORT_TAIL = /^\s*\}\s*from\s*['"]([^'"]+)['"]/
const IMPORT_BARE = /^\s*import\s*['"]([^'"]+)['"]/

/** Repo-relative, forward-slash path, so output is identical on every platform. */
const show = (path) => relative(root, path).split(sep).join('/')

/** Every file under `dir` matching `filter`, skipping caches that are not source. */
function walk(dir, filter) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__pycache__' || entry.name === 'node_modules') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path, filter))
    else if (filter(path)) out.push(path)
  }
  return out
}

/** Static specifiers with their line, so a violation can be reported as file:line. */
function specifiers(file) {
  const found = []
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      const spec = IMPORT_FROM.exec(line)?.[1] ?? IMPORT_TAIL.exec(line)?.[1] ?? IMPORT_BARE.exec(line)?.[1]
      if (spec !== undefined) found.push({ spec, line: index + 1 })
    })
  return found
}

const SUFFIXES = ['', '.ts', '.mts', '.mjs', '.js', '/index.ts', '/index.mjs', '/index.js']

/** Resolve a relative specifier the way the bundler does, or `undefined` when it points nowhere. */
function resolveRelative(from, spec) {
  const base = resolve(dirname(from), spec)
  for (const suffix of SUFFIXES) {
    const path = base + suffix
    if (existsSync(path) && statSync(path).isFile()) return path
  }
  return undefined
}

function readPackage() {
  const file = join(omp, 'package.json')
  if (!existsSync(file)) return { file, error: 'omp/package.json: missing' }
  try {
    return { file, pkg: JSON.parse(readFileSync(file, 'utf8')) }
  } catch (error) {
    return { file, error: `omp/package.json: not valid JSON (${error.message})` }
  }
}

// ---------------------------------------------------------------------------------------------
// 1. manifest

function checkManifest() {
  const { pkg, error } = readPackage()
  if (error !== undefined) return [error]
  const problems = []

  if (typeof pkg.name !== 'string' || pkg.name === '') {
    problems.push('omp/package.json: name must be a non-empty string')
  }

  if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(pkg.version)) {
    problems.push(`omp/package.json: version must be x.y.z, found ${JSON.stringify(pkg.version)}`)
  } else if (pkg.version === '0.0.0') {
    // The catalog version chain ends in 0.0.0; publishing that is indistinguishable from a
    // missing version, so the marketplace cannot resolve an update.
    problems.push('omp/package.json: version 0.0.0 cannot be resolved by the marketplace version chain')
  }

  const entries = pkg.omp?.extensions
  if (!Array.isArray(entries) || entries.length === 0) {
    problems.push('omp/package.json: omp.extensions must be a non-empty array of strings')
  }
  // Feature entries are extension entries too: `pkg[honesty]` selects *files*, so a feature that names a
  // path which does not resolve loads nothing and fails at install time with a message that does not
  // name the feature. Check both lists with one rule.
  for (const [where, list] of [['extensions', entries], ...featureLists(pkg)]) {
    if (!Array.isArray(list) || list.length === 0) {
      if (where !== 'extensions') problems.push(`omp/package.json: omp.features.${where} must name at least one entry`)
      continue
    }
    list.forEach((entry, index) => {
      if (typeof entry !== 'string' || entry === '') {
        problems.push(`omp/package.json: omp.${where}[${index}] must be a non-empty string`)
        return
      }
      const path = resolve(omp, entry)
      if (!existsSync(path) || !statSync(path).isFile()) {
        problems.push(`omp/package.json: omp.${where}[${index}] ${JSON.stringify(entry)} does not resolve from omp/`)
      }
    })
  }

  // The marketplace install path only caches and symlinks the plugin; it does not install its
  // dependencies. Any entry here is a silent broken install, not a slow one.
  for (const key of ['dependencies', 'optionalDependencies']) {
    const deps = pkg[key]
    if (deps === undefined) continue
    if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) {
      problems.push(`omp/package.json: ${key} must be an object when present`)
      continue
    }
    const names = Object.keys(deps)
    if (names.length > 0) {
      problems.push(`omp/package.json: ${key} must stay empty (marketplace never installs plugin dependencies): ${names.join(', ')}`)
    }
  }

  // The host shape is an object keyed by feature name, each `{default?, extensions?, tools?, hooks?,
  // commands?}` — verified against the installed loader, which reads `features[name]` per bracket. An
  // array here would be silently ignored and every feature would look enabled by default.
  if (pkg.omp?.features !== undefined) {
    const features = pkg.omp.features
    if (!features || typeof features !== 'object' || Array.isArray(features)) {
      problems.push('omp/package.json: omp.features must be an object keyed by feature name')
    } else {
      for (const [name, feature] of Object.entries(features)) {
        if (!FEATURES.includes(name)) {
          problems.push(`omp/package.json: omp.features contains unknown feature ${JSON.stringify(name)}`)
        }
        if (!feature || typeof feature !== 'object' || Array.isArray(feature)) {
          problems.push(`omp/package.json: omp.features.${name} must be an object`)
          continue
        }
        for (const key of Object.keys(feature)) {
          if (!FEATURE_KEYS.includes(key)) {
            problems.push(`omp/package.json: omp.features.${name} has unknown key ${JSON.stringify(key)}`)
          }
        }
        if (feature.default !== undefined && typeof feature.default !== 'boolean') {
          problems.push(`omp/package.json: omp.features.${name}.default must be a boolean`)
        }
      }
    }
  }

  return problems
}

// ---------------------------------------------------------------------------------------------
// 2. reachable

/** `[[featureName, entryList], …]` for every feature that declares entries. */
function featureLists(pkg) {
  const features = pkg?.omp?.features
  if (!features || typeof features !== 'object') return []
  const out = []
  for (const [name, feature] of Object.entries(features)) {
    const entries = Array.isArray(feature?.extensions) ? feature.extensions : []
    if (entries.length > 0) out.push([`features.${name}.extensions`, entries])
  }
  return out
}

/**
 * The manifest's extension entries and feature entries, resolved. Broken ones are `manifest`'s problem,
 * not ours.
 *
 * Feature entries must be roots: a module imported only by `honesty.ts` is reachable in every install
 * that keeps the default features, and reviewing it as dead code would train the reader to ignore this
 * check.
 */
function extensionRoots() {
  const { pkg } = readPackage()
  const declared = []
  if (Array.isArray(pkg?.omp?.extensions)) declared.push(...pkg.omp.extensions)
  for (const [, list] of featureLists(pkg)) declared.push(...list)
  return declared
    .filter((entry) => typeof entry === 'string')
    .map((entry) => resolve(omp, entry))
    .filter((path) => existsSync(path) && statSync(path).isFile())
}

/** Static import closure from `roots`: every module reached, plus unresolved relative specifiers. */
function closure(roots) {
  const reached = new Set()
  const problems = []
  const queue = [...roots]
  while (queue.length > 0) {
    const file = queue.pop()
    if (reached.has(file) || !MODULE.test(file)) continue
    reached.add(file)
    for (const { spec, line } of specifiers(file)) {
      if (!spec.startsWith('.')) continue
      const target = resolveRelative(file, spec)
      if (target === undefined) {
        problems.push(`${show(file)}:${line}: unresolved import ${JSON.stringify(spec)}`)
        continue
      }
      if (MODULE.test(target)) queue.push(target)
    }
  }
  return { reached, problems }
}

function checkReachable() {
  const production = closure(extensionRoots())
  const everything = closure([...extensionRoots(), ...walk(tests, (path) => path.endsWith('.test.ts'))])
  const problems = [...everything.problems]
  const testsOnly = []

  for (const file of walk(src, (path) => MODULE.test(path))) {
    if (!everything.reached.has(file)) {
      problems.push(`${show(file)}: imported by neither the extension entry nor any test`)
    } else if (!production.reached.has(file)) {
      testsOnly.push(show(file))
    }
  }
  return { problems, info: testsOnly.length === 0 ? [] : [testsOnly] }
}

// ---------------------------------------------------------------------------------------------
// 3. hygiene

const HYGIENE = [
  [/\bconsole\.(?:log|error)\s*\(/, 'console output'],
  [/\bprocess\.(?:exit|on)\s*\(/, 'process control'],
  [/\bdebugger\b/, 'debugger statement'],
  [/\b(?:TODO|FIXME|XXX)\b/, 'unfinished marker'],
  [/STUB — replaced by slice/, 'slice stub'],
]

function checkHygiene() {
  const problems = []
  for (const file of walk(src, (path) => TEXT.test(path))) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        for (const [pattern, label] of HYGIENE) {
          if (pattern.test(line)) problems.push(`${show(file)}:${index + 1}: ${label}`)
        }
      })
  }
  return problems
}

// ---------------------------------------------------------------------------------------------
// 4. runtime-deps

function checkRuntimeDeps() {
  const problems = []
  for (const file of walk(src, (path) => MODULE.test(path))) {
    for (const { spec, line } of specifiers(file)) {
      if (spec.startsWith('.') || spec.startsWith('node:')) continue
      problems.push(`${show(file)}:${line}: imports ${JSON.stringify(spec)} (only node: builtins and relative files)`)
    }
  }
  return problems
}

// ---------------------------------------------------------------------------------------------
// 5. provenance

const ATTRIBUTION = /co-authored-by:.*(?:agent|model|bot|assistant|claude|gpt|copilot|llm|ai\b)/i
const FOOTER = /generated (?:with|by)\b/i

function checkProvenance() {
  const problems = []
  for (const file of walk(src, (path) => TEXT.test(path))) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        const at = `${show(file)}:${index + 1}`
        if (ATTRIBUTION.test(line)) problems.push(`${at}: AI co-author attribution`)
        if (FOOTER.test(line)) problems.push(`${at}: generated-with footer`)
        if (/\p{Extended_Pictographic}/u.test(line)) problems.push(`${at}: emoji`)
      })
  }
  return problems
}

// ---------------------------------------------------------------------------------------------
// runner

const checks = [
  ['manifest', checkManifest],
  ['reachable', checkReachable],
  ['hygiene', checkHygiene],
  ['runtime-deps', checkRuntimeDeps],
  ['provenance', checkProvenance],
]

let failed = 0
for (const [name, check] of checks) {
  let result
  try {
    result = check()
  } catch (error) {
    result = [`${name}: check crashed (${error.message})`]
  }
  const { problems, info = [] } = Array.isArray(result) ? { problems: result } : result
  if (problems.length === 0) console.log(`ok ${name}`)
  else {
    failed += 1
    console.log(`FAIL ${name}`)
    for (const problem of problems) console.log(`     ${problem}`)
  }
  for (const paths of info) console.log(`info unreachable-from-extension: ${paths.join(', ')}`)
}

if (failed > 0) {
  console.log(`check-omp failed: ${failed} of ${checks.length} check(s)`)
  process.exit(1)
}
console.log(`check-omp: ${checks.length} check(s) passed`)
