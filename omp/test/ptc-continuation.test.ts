import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CoverageMeta } from '../src/kernel/outcome.ts'
import { OUTCOME_KEY, type OutcomeFacts, type ToolObservation } from '../src/host/contracts.ts'
import { continuationFor, encode } from '../src/ptc/continuation.ts'
import { continuationFor as positionalContinuation, decodeContinuation, toOutcome } from '../src/ptc/outcome.ts'
import type { CanonicalData } from '../src/ptc/types.ts'

const PREFIX = 'ops-next-v1:'

const obs = (over: Partial<ToolObservation> = {}): ToolObservation => ({
  tool: 'read',
  args: { path: 'big.txt' },
  content: [],
  details: undefined,
  isError: false,
  ...over,
})

const incomplete: CoverageMeta = {
  scannedFiles: 20,
  matchedCount: 200,
  isComplete: false,
  truncatedBy: 'row-limit',
}

const partial = (over: Partial<OutcomeFacts> = {}): OutcomeFacts => ({
  status: 'partial',
  effectState: 'none',
  retry: 'never',
  message: 'stopped early',
  coverage: incomplete,
  ...over,
})

/**
 * The recorded `details` of a live 900-line read. `totalBytes` is deliberately left at the value the
 * host actually published (1577 for a ~61 KB file), so a consumer that trusts it produces the wrong
 * path and fails the assertions below.
 */
const metaTruncation = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  direction: 'head',
  truncatedBy: 'lines',
  totalLines: 900,
  totalBytes: 1577,
  outputLines: 23,
  outputBytes: 1577,
  maxBytes: 51200,
  shownRange: { start: 1, end: 23 },
  nextOffset: 24,
  ...over,
})

const readDetails = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  totalLines: 900,
  truncation: {
    truncated: true,
    truncatedBy: 'lines',
    totalLines: 900,
    totalBytes: 1577,
    outputLines: 23,
    outputBytes: 1577,
    lastLinePartial: false,
    firstLineExceedsLimit: false,
  },
  meta: {
    source: { type: 'path', value: 'C:\\dev\\big.txt' },
    pagedSource: true,
    truncation: metaTruncation(over),
  },
})

/** The recorded `details` of a grep page that stopped on the file limit. */
const grepDetails = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  matchCount: 200,
  fileCount: 20,
  truncated: true,
  fileLimitReached: 20,
  ...over,
})

const decode = (token: string | undefined): { version: 1, tool: string, args: CanonicalData } => {
  if (typeof token !== 'string') assert.fail(`expected a continuation token, received ${String(token)}`)
  const decoded = decodeContinuation(token)
  if (decoded === undefined) assert.fail(`token did not decode: ${token}`)
  return decoded
}

test('a truncated head read names the next line range', () => {
  const token = continuationFor(obs({ details: readDetails() }), partial())
  assert.equal(typeof token, 'string')
  assert.equal(token.slice(0, PREFIX.length), PREFIX, 'the versioned prefix is part of the contract')
  // Exactly one statement of the retrieval: version, tool, args, and nothing else.
  assert.deepEqual(JSON.parse(token.slice(PREFIX.length)), {
    version: 1,
    tool: 'read',
    args: { path: 'big.txt:24-' },
  })
  assert.deepEqual(decode(token), { version: 1, tool: 'read', args: { path: 'big.txt:24-' } })
})

test('the cursor is nextOffset and never the published byte counts', () => {
  // The live record reported 1577 bytes for a ~61 KB file, so `totalBytes` cannot be a page start.
  const a = continuationFor(obs({ details: readDetails({ totalBytes: 1577, totalLines: 900 }) }), partial())
  const b = continuationFor(obs({ details: readDetails({ totalBytes: 999_999, totalLines: 4 }) }), partial())
  assert.deepEqual(decode(a).args, { path: 'big.txt:24-' })
  assert.deepEqual(decode(b).args, { path: 'big.txt:24-' }, 'totalBytes and totalLines must not move the page')
  assert.equal(a, b)
})

test('a path that already carries a selector is not extended', () => {
  const selectors = ['24', '24-48', '24+5', '2-4,9-10', 'raw', 'img', 'conflicts', '2-4:raw', '0']
  for (const selector of selectors) {
    const args = { path: `big.txt:${selector}` }
    assert.equal(continuationFor(obs({ args, details: readDetails() }), partial()), undefined,
      `extended an already-selected path: ${args.path}`)
  }
})

test('the page this module emits is advanced, not nested and not refused', () => {
  // Live: reading `:24-` in a 900-line file reports shownRange 23-323 and an absolute nextOffset 324,
  // so the next page is the same request with its start replaced. Refusing here would strand a long
  // file one page past its first continuation.
  const args = { path: 'big.txt:24-' }
  const token = continuationFor(obs({ args, details: readDetails({ nextOffset: 324 }) }), partial())
  assert.deepEqual(decode(token).args, { path: 'big.txt:324-' }, 'the open range was not rewritten')
  // Chaining is unbounded and always one selector wide.
  const third = continuationFor(obs({ args: { path: 'big.txt:324-' }, details: readDetails({ nextOffset: 624 }) }), partial())
  assert.deepEqual(decode(third).args, { path: 'big.txt:624-' })
  assert.doesNotMatch(decode(third).args.path, /:\\d+-:\\d+-/, 'nested two open ranges')
})

test('a drive letter is not a selector', () => {
  for (const path of ['C:\\dev\\big.txt', 'C:/dev/big.txt', 'C:\\dev\\a:b.txt']) {
    const token = continuationFor(obs({ args: { path }, details: readDetails() }), partial())
    assert.deepEqual(decode(token).args, { path: `${path}:24-` }, `refused a plain path: ${path}`)
  }
})

test('an offset below two proves no progress', () => {
  for (const nextOffset of [1, 0, -3, 2.5, '24', Number.NaN, null]) {
    assert.equal(continuationFor(obs({ details: readDetails({ nextOffset }) }), partial()), undefined,
      `invented a page at ${String(nextOffset)}`)
  }
  const absent = { ...readDetails(), meta: { truncation: { direction: 'head' } } }
  assert.equal(continuationFor(obs({ details: absent }), partial()), undefined)
})

test('only a head truncation has a next page', () => {
  for (const direction of ['tail', 'both', 'head-ish', undefined]) {
    assert.equal(continuationFor(obs({ details: readDetails({ direction }) }), partial()), undefined,
      `paged a ${String(direction)} truncation`)
  }
})

test('a read with no usable path has no page', () => {
  const args: readonly unknown[] = [{}, { path: 7 }, { path: '' }, { path: null }, 'big.txt', ['big.txt'], null]
  for (const value of args) {
    assert.equal(continuationFor(obs({ args: value, details: readDetails() }), partial()), undefined,
      `paged ${JSON.stringify(value)}`)
  }
  assert.equal(continuationFor(obs({ details: undefined }), partial()), undefined)
  assert.equal(continuationFor(obs({ details: 'text' }), partial()), undefined)
})

test('the headline grep page advances by the files it read', () => {
  const token = continuationFor(obs({ tool: 'grep', args: { pattern: 'x' }, details: grepDetails() }), partial())
  assert.deepEqual(decode(token), { version: 1, tool: 'grep', args: { pattern: 'x', skip: 20 } })

  // A page already skipped past the first twenty files advances from where it is, not from zero.
  const again = continuationFor(
    obs({ tool: 'grep', args: { pattern: 'x', skip: 20 }, details: grepDetails() }),
    partial(),
  )
  assert.deepEqual(decode(again).args, { pattern: 'x', skip: 40 })

  // A per-file cap on the same page does not veto the file-page cursor: the scan stopped between
  // files, so the next file page still starts at a file the capped page never listed.
  const both = continuationFor(
    obs({ tool: 'grep', args: { pattern: 'x' }, details: grepDetails({ perFileLimitReached: 5, linesTruncated: true }) }),
    partial(),
  )
  assert.deepEqual(decode(both).args, { pattern: 'x', skip: 20 })
})

test('grep caps that re-issuing the same page cannot get past yield nothing', () => {
  // A page whose only proof is a per-file cap or a column cut returns the same rows when re-issued.
  const capped = (over: Record<string, unknown>): Record<string, unknown> => ({
    matchCount: 200,
    fileCount: 20,
    truncated: true,
    ...over,
  })
  const cases: readonly Record<string, unknown>[] = [
    { perFileLimitReached: 5 },
    { linesTruncated: true },
    { perFileLimitReached: 5, linesTruncated: true },
    { fileLimitReached: 0 },
    { fileLimitReached: -1 },
    { fileLimitReached: '20' },
    { fileLimitReached: 5.5 },
    { fileLimitReached: 20, fileCount: 0 },
    { fileLimitReached: 20, fileCount: '20' },
  ]
  for (const over of cases) {
    assert.equal(continuationFor(obs({ tool: 'grep', args: { pattern: 'x' }, details: capped(over) }), partial()),
      undefined, `paged a capped scan: ${JSON.stringify(over)}`)
  }
})

test('a complete fact outranks a cursor', () => {
  const complete = partial({ coverage: { ...incomplete, isComplete: true } })
  assert.equal(continuationFor(obs({ details: readDetails() }), complete), undefined)
  assert.equal(continuationFor(obs({ tool: 'grep', details: grepDetails() }), complete), undefined)
  const bareComplete = partial({ coverage: { scannedFiles: 1, matchedCount: 1, isComplete: true } })
  assert.equal(continuationFor(obs({ tool: 'grep', details: grepDetails() }), bareComplete), undefined)
})

test('every emitted token decodes back to exactly the args it names', () => {
  const emitted: readonly [ToolObservation, CanonicalData][] = [
    [obs({ details: readDetails({ nextOffset: 24 }) }), { path: 'big.txt:24-' }],
    [obs({ details: readDetails({ nextOffset: 880 }) }), { path: 'big.txt:880-' }],
    [obs({ tool: 'grep', args: { pattern: 'x' }, details: grepDetails() }), { pattern: 'x', skip: 20 }],
    [obs({ tool: 'grep', args: { pattern: 'x', skip: 20 }, details: grepDetails() }), { pattern: 'x', skip: 40 }],
    [obs({ tool: 'grep', args: { pattern: 'x', skip: '20' }, details: grepDetails() }), { pattern: 'x', skip: 40 }],
    [obs({ tool: 'grep', args: { pattern: 'x', glob: '*.ts', skip: 5 }, details: grepDetails() }),
      { pattern: 'x', glob: '*.ts', skip: 25 }],
  ]
  for (const [observation, args] of emitted) {
    const token = continuationFor(observation, partial())
    assert.deepEqual(decode(token), { version: 1, tool: observation.tool, args })
    // The token carries no state beyond the retrieval it names.
    assert.deepEqual(Object.keys(JSON.parse(token!.slice(PREFIX.length))).sort(), ['args', 'tool', 'version'])
  }
})

test('a token over the byte cap is refused, not truncated', () => {
  const fits = continuationFor(obs({ args: { path: `${'x'.repeat(8000)}.txt` }, details: readDetails() }), partial())
  assert.equal(typeof fits, 'string')
  assert.ok(Buffer.byteLength(fits!, 'utf8') <= 8192)

  const huge = continuationFor(obs({ args: { path: `${'x'.repeat(9000)}.txt` }, details: readDetails() }), partial())
  assert.equal(huge, undefined, 'a continuation that cannot be pasted is not a continuation')
  assert.equal(encode('read', { path: `${'x'.repeat(9000)}.txt:24-` }), undefined)
})

test('encode refuses values JSON cannot spell rather than emitting a lossy token', () => {
  assert.equal(encode('read', { path: 7n as unknown as string }), undefined)
  const cyclic: CanonicalData = { path: 'big.txt:24-' }
  cyclic.self = cyclic
  assert.equal(encode('read', cyclic), undefined)
  // The one encoder and the cursor logic agree byte for byte.
  assert.equal(encode('read', { path: 'big.txt:24-' }),
    continuationFor(obs({ details: readDetails() }), partial()))
})

test('no tool other than read and grep emits a page', () => {
  const details = { ...grepDetails(), meta: { truncation: metaTruncation() } }
  for (const tool of ['write', 'edit', 'glob', 'bash', 'eval', 'task', 'grep', 'read']) {
    const observation = obs({ tool, args: { path: 'big.txt', pattern: 'x' }, details })
    if (tool === 'read' || tool === 'grep') {
      assert.notEqual(continuationFor(observation, partial()), undefined, `${tool} lost its page`)
    } else {
      assert.equal(continuationFor(observation, partial()), undefined, `${tool} fabricated a page`)
    }
  }
})

test('the positional adapter cannot see a cursor', () => {
  // A cursor lives in `details`, and the positional form carries none, so it can never prove a page.
  assert.equal(positionalContinuation('read', { path: 'big.txt' }, partial()), undefined)
  assert.equal(positionalContinuation('grep', { pattern: 'x' }, partial()), undefined)
})

test('toOutcome publishes the page the observation proves', () => {
  const details = { ...readDetails(), [OUTCOME_KEY]: { status: 'partial', effectState: 'none', retry: 'never', message: 'stopped early', coverage: incomplete } }
  const outcome = toOutcome(obs({ details }))
  if (outcome.status !== 'partial') assert.fail(`expected partial, received ${outcome.status}`)
  assert.deepEqual(decode(outcome.continuation).args, { path: 'big.txt:24-' })
  assert.equal(outcome.coverage.isComplete, false)

  const grep = { ...grepDetails(), [OUTCOME_KEY]: { status: 'partial', effectState: 'none', retry: 'never', message: 'stopped early', coverage: incomplete } }
  const paged = toOutcome(obs({ tool: 'grep', args: { pattern: 'x' }, details: grep }))
  if (paged.status !== 'partial') assert.fail(`expected partial, received ${paged.status}`)
  assert.deepEqual(decode(paged.continuation).args, { pattern: 'x', skip: 20 })
})

test('toOutcome still refuses a partial observation with no provable page', () => {
  const details = {
    matchCount: 200,
    fileCount: 20,
    perFileLimitReached: 5,
    [OUTCOME_KEY]: { status: 'partial', effectState: 'none', retry: 'never', message: 'stopped early', coverage: incomplete },
  }
  const outcome = toOutcome(obs({ tool: 'grep', args: { pattern: 'x' }, details }))
  if (outcome.status === 'completed' || outcome.status === 'partial') assert.fail(`expected a failure, received ${outcome.status}`)
  assert.equal(outcome.error.code, 'RESULT_PARTIAL')
  assert.equal('continuation' in outcome, false)
  assert.equal('coverage' in outcome, false)
})
