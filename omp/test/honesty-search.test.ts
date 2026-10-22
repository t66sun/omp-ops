import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OUTCOME_KEY, type OutcomeFacts, type ToolObservation } from '../src/host/contracts.ts'
import type { MutableResult } from '../src/pipeline.ts'
import { transform } from '../src/rules/search.ts'

/**
 * Fixtures are wire payloads from omp 18.12.6, not documents: the grep shapes below are the ones a
 * probe extension logged from real `tool_result` events (see the comment in `src/rules/search.ts`
 * and `docs/porting/spike-report.md`). `details.files`, `fileMatches` and `displayContent` are
 * dropped wherever the rule never reads them.
 */

const details = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  scopePath: '.',
  searchPath: 'src',
  cwd: 'C:\\probe',
  matchCount: 7,
  fileCount: 3,
  truncated: false,
  ...over,
})

const observation = (over: {
  tool?: string
  args?: unknown
  content?: unknown[]
  details?: unknown
  isError?: boolean
} = {}): ToolObservation => ({
  tool: over.tool ?? 'grep',
  args: over.args ?? { pattern: 'q', path: 'src' },
  content: over.content ?? [{ type: 'text', text: 'src/a.ts:1: q' }],
  details: 'details' in over ? over.details : details(),
  isError: over.isError ?? false,
})

const result = (value: unknown): MutableResult => ({
  content: [{ type: 'text', text: 'src/a.ts:1: q' }],
  details: value,
  isError: false,
})

const factsOf = (out: MutableResult): OutcomeFacts => {
  const record = out.details as Record<string, unknown>
  const value = record[OUTCOME_KEY]
  assert.ok(value !== undefined, 'the rule must write outcome facts')
  return value as OutcomeFacts
}

/** Every case goes through here: a rule that touches `content` fails, whatever it wrote. */
const applied = (o: ToolObservation, value: unknown = details()): MutableResult => {
  const out = result(value)
  const before = JSON.stringify(out.content)
  transform.apply(o, out)
  assert.equal(JSON.stringify(out.content), before, 'content must stay byte-identical')
  assert.equal(out.isError, false)
  return out
}

const untouched = (o: ToolObservation, value: unknown = details()): void => {
  const out = applied(o, value)
  const record = out.details as Record<string, unknown>
  assert.equal(record[OUTCOME_KEY], undefined)
  assert.deepEqual(out.details, value)
}

test('declares the frozen identity of the search slice', () => {
  assert.equal(transform.name, 'rules/search')
  assert.deepEqual(transform.features, ['honesty'])
})

test('a scan with no cut is completed with isComplete true and observed counts', () => {
  const out = applied(observation())
  const facts = factsOf(out)
  assert.equal(facts.status, 'completed')
  assert.equal(facts.coverage?.isComplete, true)
  assert.equal(facts.coverage?.scannedFiles, 3)
  assert.equal(facts.coverage?.matchedCount, 7)
  assert.equal(facts.coverage?.truncatedBy, undefined)
  assert.equal(facts.effectState, 'none')
  assert.equal(facts.retry, 'never')
  assert.ok(facts.message.includes('coverage complete'))
})

test('each of the four cut flags independently forces partial with isComplete false', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['truncated', { truncated: true }],
    ['fileLimitReached', { truncated: true, fileLimitReached: 20 }],
    ['perFileLimitReached', { truncated: true, perFileLimitReached: 20 }],
    ['linesTruncated', { linesTruncated: true }],
  ]
  for (const [name, over] of cases) {
    const facts = factsOf(applied(observation({ details: details(over) })))
    assert.equal(facts.status, 'partial', `${name} must not read as a complete scan`)
    assert.equal(facts.coverage?.isComplete, false, `${name} must not claim complete coverage`)
  }
})

test('a flag that is only present without `truncated` still forces partial', () => {
  // `fileLimitReached` is a number, not a boolean, and its presence is the flag.
  for (const over of [{ fileLimitReached: 20 }, { perFileLimitReached: 20 }, { truncated: true }]) {
    const facts = factsOf(applied(observation({ details: details(over) })))
    assert.equal(facts.status, 'partial')
    assert.equal(facts.coverage?.isComplete, false)
  }
})

test('missingPaths forces partial even when nothing was truncated', () => {
  const facts = factsOf(applied(observation({ details: details({ missingPaths: ['nope-dir'] }) })))
  assert.equal(facts.status, 'partial')
  assert.equal(facts.coverage?.isComplete, false)
  assert.equal(facts.coverage?.truncatedBy, undefined, 'a missing path is not a truncation')
  assert.ok(facts.message.includes('1 requested path did not exist'))
})

test('the cause is the most specific one: time, then line cut, then scan budget', () => {
  const timedOut = observation({
    details: details({ truncated: true, fileLimitReached: 20 }),
    content: [{ type: 'text', text: 'grep timed out after 30000ms' }],
  })
  assert.equal(factsOf(applied(timedOut)).coverage?.truncatedBy, 'time-limit')

  // One file, ten short lines, reported in full: `truncated` alone cannot mean an output cut.
  const bare = details({ truncated: true, matchCount: 10, fileCount: 1 })
  assert.equal(factsOf(applied(observation({ details: bare }))).coverage?.truncatedBy, 'scan-budget')

  const longLines = details({ truncated: true, linesTruncated: true, fileLimitReached: 20 })
  assert.equal(factsOf(applied(observation({ details: longLines }))).coverage?.truncatedBy, 'output-budget')

  const files = details({ truncated: true, fileLimitReached: 20 })
  assert.equal(factsOf(applied(observation({ details: files }))).coverage?.truncatedBy, 'scan-budget')

  const perFile = details({ truncated: true, perFileLimitReached: 20 })
  assert.equal(factsOf(applied(observation({ details: perFile }))).coverage?.truncatedBy, 'scan-budget')
})

test('a timeout with no counts at all is still a partial scan, never a complete one', () => {
  const facts = factsOf(applied(observation({
    details: { scopePath: 'src' },
    content: [{ type: 'text', text: 'Request timeout' }],
  })))
  assert.equal(facts.status, 'partial')
  assert.equal(facts.coverage?.isComplete, false)
  assert.equal(facts.coverage?.truncatedBy, 'time-limit')
  assert.ok(facts.message.includes('total unknown'))
})

test('an incomplete result never carries a claimed total', () => {
  const incomplete = [
    details({ truncated: true }),
    details({ fileLimitReached: 20 }),
    details({ perFileLimitReached: 20 }),
    details({ linesTruncated: true }),
    details({ missingPaths: ['nope-dir'] }),
    details({},),
  ]
  for (const value of incomplete) {
    for (const args of [{ pattern: 'q', path: 'src' }, { pattern: 'q', path: 'src', skip: 20 }]) {
      const facts = factsOf(applied(observation({ details: value, args }), value))
      if (facts.status === 'completed') continue
      const serialized = JSON.stringify(facts)
      assert.ok(!serialized.includes('matchedTotal'), 'partial results must not carry a total')
      assert.ok(!serialized.includes('"total"'), 'partial results must not carry a total')
      assert.ok(!/\btotal\b(?! unknown)/i.test(facts.message), `message claims a total: ${facts.message}`)
      assert.ok(/total unknown/i.test(facts.message), `message must state the total is unknown: ${facts.message}`)
      assert.equal(facts.coverage?.isComplete, false)
      assert.equal(typeof facts.coverage?.matchedCount, 'number')
    }
  }
})

test('a paged continuation is never reported as a complete scan', () => {
  const facts = factsOf(applied(observation({ args: { pattern: 'q', path: 'src', skip: 20 } })))
  assert.equal(facts.status, 'partial')
  assert.equal(facts.coverage?.isComplete, false)
  assert.equal(facts.coverage?.truncatedBy, 'row-limit')
  assert.ok(facts.message.includes('one page of a paged scan'))
})

test('the internal 2000-match cap is not a magic count: the flags carry it', () => {
  // Probe evidence: a page holds at most 20 files x 20 matches (200 for a single-file search), so
  // `matchCount` cannot reach 2000; the scan cap shows up as `truncated`/limit keys or as a clean
  // empty page after `skip` is past the cut, never as a bare 2000.
  const facts = factsOf(applied(observation({ details: details({ matchCount: 2000, fileCount: 20 }) })))
  assert.equal(facts.status, 'completed')
  assert.equal(facts.coverage?.matchedCount, 2000)

  const cut = factsOf(applied(observation({ details: details({ matchCount: 2000, fileCount: 20, truncated: true }) })))
  assert.equal(cut.status, 'partial')
})

test('a successful read or bash is ignored', () => {
  untouched(observation({ tool: 'read', details: { resolvedPath: 'src/a.ts', truncation: { truncated: false } } }))
  untouched(observation({ tool: 'bash', details: { wallTimeMs: 12, timeoutSeconds: 60 } }))
  untouched(observation({ tool: 'grep', details: { bytes: 4 } }))
})

test('glob reports a cut listing and nothing else', () => {
  const cut = {
    scopePath: 'src',
    fileCount: 200,
    files: ['a.ts'],
    truncated: true,
    resultLimitReached: 200,
    cwd: 'C:\\probe',
  }
  const facts = factsOf(applied(observation({ tool: 'glob', args: { pattern: '**/*.ts' }, details: cut }), cut))
  assert.equal(facts.status, 'partial')
  assert.equal(facts.coverage?.isComplete, false)
  assert.equal(facts.coverage?.truncatedBy, 'row-limit')
  assert.equal(facts.coverage?.matchedCount, 200)
  assert.ok(/total unknown/i.test(facts.message))

  untouched(observation({ tool: 'glob', details: { scopePath: 'src', fileCount: 3, files: ['a.ts'], truncated: false } }))
})

test('facts already written by another rule are left alone', () => {
  const existing: OutcomeFacts = {
    status: 'completed',
    effectState: 'none',
    retry: 'never',
    message: 'earlier rule',
  }
  const value = details({ truncated: true, [OUTCOME_KEY]: existing })
  const out = applied(observation({ details: value }), value)
  assert.deepEqual(factsOf(out), existing)
})

test('details that cannot be written to leave the result untouched and never throw', () => {
  const frozen = Object.freeze(details({ truncated: true }))
  const out = result(frozen)
  assert.doesNotThrow(() => transform.apply(observation({ details: frozen }), out))
  assert.equal((frozen as Record<string, unknown>)[OUTCOME_KEY], undefined)

  untouched(observation({ details: undefined }))
  untouched(observation({ details: null }))
  untouched(observation({ details: ['not', 'a', 'record'] }))
})

test('an error grep without a timeout message gets no coverage facts', () => {
  untouched(observation({ isError: true, details: details(), content: [{ type: 'text', text: 'Path not found' }] }))
})

test('applying twice writes the same facts and appends nothing', () => {
  const out = result(details({ truncated: true }))
  transform.apply(observation({ details: details({ truncated: true }) }), out)
  const first = JSON.stringify(out)
  transform.apply(observation({ details: details({ truncated: true }) }), out)
  assert.equal(JSON.stringify(out), first)
  assert.equal(out.content.length, 1)
})
