#!/usr/bin/env node
/**
 * Proves the parallel-slice rule held (restructuringPLAN.md §5.0 rule 1): no two
 * slices may touch the same file, so merge order never affects correctness.
 *
 * Three kinds of commit touch `omp/`, and only the first is subject to the rule:
 *
 *   spine       the contract commit that pre-creates one stub per slice, so the
 *               slices never race on a shared barrel. Exempt by construction.
 *   slice       a PR-numbered commit, one slice per PR. Must be disjoint.
 *   amendment   an unnumbered commit that changes a contract after the freeze.
 *               Exempt, but every file it touches outside the freeze zone is
 *               printed, because that is exactly where drift can hide.
 *
 *   node scripts/check-slices.mjs            # whole history of omp/
 *   node scripts/check-slices.mjs <since>    # from a commit, tag or date
 */
import { execFileSync } from 'node:child_process'

const SINCE = process.argv[2]

/**
 * The frozen interface files (restructuringPLAN.md §5.2). A slice may edit them
 * only to record a contract amendment, which is why they are exempt from the
 * disjointness rule rather than from review.
 */
const FREEZE_ZONE = [
  'omp/package.json',
  'omp/tsconfig.json',
  'omp/src/kernel/',
  'omp/src/host/contracts.ts',
  'omp/src/pipeline.ts',
  'omp/src/extension/index.ts',
  'omp/src/rules/index.ts',
  'omp/src/render/index.ts',
  'omp/src/dedup/index.ts',
  'omp/src/dedup/types.ts',
  'omp/src/ptc/index.ts',
  'omp/src/ptc/types.ts',
]

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function inFreezeZone(path) {
  return FREEZE_ZONE.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry))
}

const range = SINCE ? [SINCE + '..HEAD'] : ['HEAD']
const commits = git(['log', '--format=%H%x1f%s', ...range, '--', 'omp/'])
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [sha, subject] = line.split('\x1f')
    return { sha, subject }
  })

// `git log` lists newest first, so the last entry is the commit that introduced `omp/`.
const spine = commits.at(-1)
const slices = commits.filter((c) => c !== spine && /\(#\d+\)$/.test(c.subject))
const amendments = commits.filter((c) => c !== spine && !/\(#\d+\)$/.test(c.subject))

function filesOf(commit) {
  return git(['show', '--name-only', '--format=', commit.sha, '--', 'omp/']).split('\n').filter(Boolean)
}

const owners = new Map()
for (const slice of slices) {
  for (const file of filesOf(slice)) {
    if (inFreezeZone(file)) continue
    if (!owners.has(file)) owners.set(file, [])
    owners.get(file).push(slice.subject)
  }
}

const shared = [...owners.entries()].filter(([, touchedBy]) => touchedBy.length > 1)

if (amendments.length > 0) {
  console.log(`${amendments.length} amendment commit(s), files changed outside the freeze zone:`)
  for (const amendment of amendments) {
    const outside = filesOf(amendment).filter((file) => !inFreezeZone(file))
    console.log(`  ${amendment.subject}`)
    for (const file of outside) console.log(`    ${file}`)
  }
  console.log('')
}

const summary = `${slices.length} slice(s) touching omp/, ${owners.size} exclusive file(s)`

if (shared.length === 0) {
  console.log(`slices ok: ${summary}`)
  process.exit(0)
}

console.error(`slices broken: ${shared.length} file(s) owned by more than one slice`)
for (const [file, touchedBy] of shared) {
  console.error(`  ${file}`)
  for (const slice of touchedBy) console.error(`    - ${slice}`)
}
process.exit(1)
