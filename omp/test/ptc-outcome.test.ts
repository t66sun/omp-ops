import assert from 'node:assert/strict'
import { test } from 'node:test'
import { errorPolicy } from '../src/kernel/errors.ts'
import type { CoverageMeta, Outcome } from '../src/kernel/outcome.ts'
import { OUTCOME_KEY, type OutcomeFacts, type ToolObservation } from '../src/host/contracts.ts'
import { continuationFor, decodeContinuation, toOutcome } from '../src/ptc/outcome.ts'
import { count, record, type CanonicalData } from '../src/ptc/types.ts'
import * as barrel from '../src/ptc/index.ts'

const PREFIX = 'ops-next-v1:'

const obs = (over: Partial<ToolObservation> = {}): ToolObservation => ({
  tool: 'read',
  args: { path: 'note.txt' },
  content: [],
  details: undefined,
  isError: false,
  ...over,
})

/** The shape a rule publishes: details plus the facts envelope under `outcome.v1`. */
const withFacts = (facts: Partial<OutcomeFacts> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...extra,
  [OUTCOME_KEY]: { status: 'completed', effectState: 'none', retry: 'never', message: 'done', ...facts },
})

const failureOf = (outcome: Outcome<CanonicalData>) => {
  if (outcome.status === 'completed' || outcome.status === 'partial') {
    assert.fail(`expected a failure outcome, received ${outcome.status}`)
  }
  return outcome
}

const coverage = (over: Partial<CoverageMeta> = {}): CoverageMeta => ({
  scannedFiles: 4,
  matchedCount: 2,
  isComplete: true,
  ...over,
})

test('an unclassified failure claims unknown effects and forbids retrying', () => {
  const outcome = failureOf(toOutcome(obs({ isError: true, details: { stderr: 'boom' } })))
  assert.equal(outcome.status, 'unknown')
  assert.equal(outcome.error.code, 'RESULT_UNKNOWN')
  assert.equal(outcome.error.effectState, 'unknown')
  // Derived by the kernel, never written here: `never` is what `errorPolicy` answers for an
  // unbounded effect, and the projection must not soften it.
  assert.equal(outcome.error.retry, errorPolicy('RESULT_UNKNOWN', 'unknown').retry)
  assert.equal(outcome.error.retry, 'never')
})

test('a clean observation is completed and makes no coverage claim at all', () => {
  const outcome = toOutcome(obs({ details: { body: 'alpha' } }))
  if (outcome.status !== 'completed') assert.fail(`expected completed, received ${outcome.status}`)
  assert.deepEqual(outcome.data, { body: 'alpha', tool: 'read' })
  // The absence of coverage accounting is not a claim of completeness.
  assert.equal('coverage' in outcome, false)
  assert.equal('continuation' in outcome, false)
})

test('a completed fact projects its coverage through, with the call identity', () => {
  const outcome = toOutcome(obs({
    tool: 'grep',
    callId: 'call-7',
    details: withFacts({ coverage: coverage() }, { files: ['a.txt'] }),
  }))
  if (outcome.status !== 'completed') assert.fail(`expected completed, received ${outcome.status}`)
  assert.deepEqual(outcome.coverage, { scannedFiles: 4, matchedCount: 2, isComplete: true })
  assert.deepEqual(outcome.data, { files: ['a.txt'], tool: 'grep', callId: 'call-7' })
  assert.equal('continuation' in outcome, false)
})

test('a completed fact without coverage stays completed and adds none', () => {
  const outcome = toOutcome(obs({ details: withFacts({ message: 'ok' }) }))
  if (outcome.status !== 'completed') assert.fail(`expected completed, received ${outcome.status}`)
  assert.equal('coverage' in outcome, false)
})

test('coverage fields the kernel cannot read are sanitised, not passed through', () => {
  const outcome = toOutcome(obs({
    details: withFacts({ coverage: { scannedFiles: 'many', matchedCount: -2, isComplete: true, truncatedBy: 'made-up' } as unknown as CoverageMeta }),
  }))
  if (outcome.status !== 'completed') assert.fail(`expected completed, received ${outcome.status}`)
  assert.deepEqual(outcome.coverage, { matchedCount: 0, isComplete: true })
})

test('a truncation cause is carried under the kernel spelling', () => {
  const outcome = toOutcome(obs({ details: withFacts({ coverage: coverage({ truncatedBy: 'time' }) }) }))
  if (outcome.status !== 'completed') assert.fail(`expected completed, received ${outcome.status}`)
  assert.equal(outcome.coverage?.truncatedBy, 'time-limit')
  const kept = toOutcome(obs({ details: withFacts({ coverage: coverage({ truncatedBy: 'output-budget' }) }) }))
  if (kept.status !== 'completed') assert.fail(`expected completed, received ${kept.status}`)
  assert.equal(kept.coverage?.truncatedBy, 'output-budget')
})

test('a completed fact contradicted by incomplete coverage downgrades to the incomplete case', () => {
  const outcome = failureOf(toOutcome(obs({ details: withFacts({ coverage: coverage({ isComplete: false }) }) })))
  assert.equal(outcome.error.code, 'RESULT_PARTIAL')
  assert.equal(outcome.status, errorPolicy('RESULT_PARTIAL', 'none').status)
  assert.equal('continuation' in outcome, false)
  assert.equal('coverage' in outcome, false)
})

test('a partial fact never yields an invented continuation', () => {
  const facts: Partial<OutcomeFacts> = {
    status: 'partial',
    coverage: coverage({ isComplete: false, truncatedBy: 'scan-budget' }),
  }
  const outcome = failureOf(toOutcome(obs({ tool: 'grep', details: withFacts(facts) })))
  assert.equal('continuation' in outcome, false)
  assert.equal(outcome.error.code, 'RESULT_PARTIAL')
  assert.equal(outcome.error.retry, errorPolicy('RESULT_PARTIAL', 'none').retry)
  assert.deepEqual(outcome.data, { tool: 'grep' })
})

test('a partial fact without coverage cannot even be typed as partial', () => {
  const outcome = failureOf(toOutcome(obs({ details: withFacts({ status: 'partial' }) })))
  assert.equal(outcome.error.code, 'RESULT_PARTIAL')
  assert.equal('continuation' in outcome, false)
})

test('continuationFor answers undefined for every tool and every cursor-like field', () => {
  const partial = (extra: Record<string, unknown> = {}): OutcomeFacts => ({
    status: 'partial',
    effectState: 'none',
    retry: 'never',
    message: 'stopped early',
    coverage: coverage({ isComplete: false, truncatedBy: 'scan-budget' }),
    ...extra,
  }) as OutcomeFacts
  const cases: readonly [string, unknown, OutcomeFacts][] = [
    ['grep', { pattern: 'x' }, partial()],
    ['read', { path: 'note.txt', offset: 1 }, partial()],
    ['glob', { pattern: '**/*.ts' }, partial()],
    ['read', { path: 'note.txt' }, partial({ nextOffset: 40 })],
    ['grep', { pattern: 'x' }, partial({ nextFile: 'b.txt', nextOffset: 9 })],
    ['read', { path: 'note.txt' }, { ...partial(), status: 'completed' }],
  ]
  for (const [tool, args, facts] of cases) {
    assert.equal(continuationFor(tool, args, facts), undefined, `${tool} fabricated a page`)
  }
})

test('a failure fact keeps the retry advice its producer published', () => {
  // `EXIT_CODE` with an unknown effect is the kernel's one documented producer-side override: the
  // effect stays unknown, but a changed input may be safe. `errorPolicy('EXIT_CODE', 'unknown')`
  // collapses to `never`, so recomputing from the code alone would erase the override — which is
  // exactly what the projection must not do.
  const bash = failureOf(toOutcome(obs({
    tool: 'bash',
    isError: true,
    details: withFacts({ status: 'error', code: 'EXIT_CODE', effectState: 'unknown', retry: 'after-input-change', message: 'exit 3' }),
  })))
  assert.equal(bash.status, 'unknown')
  assert.equal(bash.error.retry, 'after-input-change')
  assert.notEqual(bash.error.retry, errorPolicy('EXIT_CODE', 'unknown').retry, 'recomputing would erase the override')
  assert.equal(bash.error.code, 'EXIT_CODE')
  assert.equal(bash.error.effectState, 'unknown')
  assert.equal(bash.error.message, 'exit 3')

  // A published retry that is not one of the four legal advices is not advice: the policy answers.
  const nonsense = failureOf(toOutcome(obs({
    tool: 'bash',
    isError: true,
    details: withFacts({ status: 'error', code: 'EXIT_CODE', effectState: 'unknown', retry: 'sure-go-ahead', message: 'exit 3' }),
  })))
  assert.equal(nonsense.error.retry, errorPolicy('EXIT_CODE', 'unknown').retry)
  assert.equal(nonsense.error.retry, 'never')

  const denied = failureOf(toOutcome(obs({
    isError: true,
    details: withFacts({ status: 'rejected', code: 'POLICY_DENIED', effectState: 'none', message: 'not allowed' }),
  })))
  assert.equal(denied.status, errorPolicy('POLICY_DENIED', 'none').status)
  assert.equal(denied.error.retry, errorPolicy('POLICY_DENIED', 'none').retry)
  assert.equal(denied.status, 'rejected')
  assert.equal(denied.error.retry, 'never')
})

test('a settled failure keeps its applied effect state and next action', () => {
  const outcome = failureOf(toOutcome(obs({
    isError: true,
    details: withFacts({
      status: 'error',
      code: 'IO_ERROR',
      effectState: 'applied',
      retry: 'never',
      message: 'write failed after the rename',
      nextAction: 'inspect the target',
    }),
  })))
  assert.equal(outcome.error.effectState, 'applied')
  assert.equal(outcome.error.retry, 'never')
  assert.equal(outcome.error.retry, errorPolicy('IO_ERROR', 'applied').retry, 'a settled effect and its advice agree')
  assert.equal(outcome.error.nextAction, 'inspect the target')
})

test('an unreadable effect state is treated as unknown, never as harmless', () => {
  const outcome = failureOf(toOutcome(obs({
    isError: true,
    details: withFacts({ status: 'error', code: 'IO_ERROR', effectState: 'probably-fine' }),
  })))
  assert.equal(outcome.error.effectState, 'unknown')
  assert.equal(outcome.error.retry, 'never')
})

test('a failure fact with no readable code is unknown, not the status it claimed', () => {
  const outcome = failureOf(toOutcome(obs({ isError: true, details: withFacts({ status: 'rejected' }) })))
  assert.equal(outcome.error.code, 'RESULT_UNKNOWN')
  assert.equal(outcome.status, errorPolicy('RESULT_UNKNOWN', 'none').status)
  assert.equal(outcome.status, 'unknown')
})

test('facts make a success even when the host flagged an error', () => {
  const outcome = toOutcome(obs({ isError: true, details: withFacts({ coverage: coverage() }) }))
  assert.equal(outcome.status, 'completed')
})

test('unrepresentable details are dropped instead of thrown', () => {
  const cyclic: Record<string, unknown> = {
    keep: 'yes',
    big: 7n,
    fn: () => 1,
    symbol: Symbol('s'),
    undef: undefined,
    inf: Infinity,
    nan: NaN,
    list: [1, 2n, 'x', () => 2],
  }
  cyclic.self = cyclic
  cyclic.nested = { back: cyclic }
  const outcome = toOutcome(obs({ details: cyclic }))
  if (outcome.status !== 'completed') assert.fail(`expected completed, received ${outcome.status}`)
  assert.deepEqual(outcome.data, { keep: 'yes', list: [1, 'x'], nested: {}, tool: 'read' })
  assert.deepEqual(JSON.parse(JSON.stringify(outcome)), outcome)
})

test('the raw facts envelope is not duplicated inside data', () => {
  const outcome = toOutcome(obs({ details: withFacts({ coverage: coverage() }, { body: 'alpha' }) }))
  if (outcome.status !== 'completed') assert.fail(`expected completed, received ${outcome.status}`)
  assert.equal(OUTCOME_KEY in outcome.data, false)
  assert.equal('outcome.v1' in outcome.data, false)
})

test('the observation owns the call identity, not the payload', () => {
  const outcome = toOutcome(obs({ tool: 'grep', callId: 'call-9', details: { tool: 'inner', callId: 'inner-call' } }))
  if (outcome.status !== 'completed') assert.fail(`expected completed, received ${outcome.status}`)
  assert.equal(outcome.data.tool, 'grep')
  assert.equal(outcome.data.callId, 'call-9')
})

test('an empty or absent callId is not published', () => {
  const empty = toOutcome(obs({ callId: '', details: {} }))
  if (empty.status !== 'completed') assert.fail(`expected completed, received ${empty.status}`)
  assert.equal('callId' in empty.data, false)
  const absent = toOutcome(obs({ details: {} }))
  if (absent.status !== 'completed') assert.fail(`expected completed, received ${absent.status}`)
  assert.equal('callId' in absent.data, false)
})

test('details that are not a named object leave only the identity', () => {
  for (const details of [undefined, null, 'text', 7, ['a', 'b']]) {
    const outcome = toOutcome(obs({ details }))
    if (outcome.status !== 'completed') assert.fail(`expected completed, received ${outcome.status}`)
    assert.deepEqual(outcome.data, { tool: 'read' })
  }
})

test('every outcome survives a JSON round trip', () => {
  const observations: readonly ToolObservation[] = [
    obs(),
    obs({ details: { body: 'alpha', count: 2, ok: true } }),
    obs({ callId: 'call-1', details: withFacts({ coverage: coverage({ truncatedBy: 'row-limit' }) }) }),
    obs({ isError: true, details: withFacts({ status: 'error', code: 'EXIT_CODE', effectState: 'unknown' }) }),
    obs({ isError: true, details: undefined }),
    obs({ details: withFacts({ status: 'partial', coverage: coverage({ isComplete: false }) }) }),
  ]
  for (const observation of observations) {
    const outcome = toOutcome(observation)
    assert.deepEqual(JSON.parse(JSON.stringify(outcome)), outcome)
  }
})

test('decodeContinuation accepts a v1 read token and drops unknown fields', () => {
  const token = `${PREFIX}${JSON.stringify({ version: 1, tool: 'read', args: { path: 'note.txt' }, extra: 1 })}`
  assert.deepEqual(decodeContinuation(token), { version: 1, tool: 'read', args: { path: 'note.txt' } })
})

test('decodeContinuation rejects tokens it cannot vouch for', () => {
  const good = (value: Record<string, unknown>): string => `${PREFIX}${JSON.stringify(value)}`
  const rejected: readonly unknown[] = [
    `ops-next-v2:${JSON.stringify({ version: 1, tool: 'read', args: {} })}`,
    good({ version: 2, tool: 'read', args: {} }),
    good({ tool: 'read', args: {} }),
    good({ version: 1, tool: '', args: {} }),
    good({ version: 1, tool: 7, args: {} }),
    good({ version: 1, tool: 'read' }),
    good({ version: 1, tool: 'read', args: 'note.txt' }),
    good({ version: 1, tool: 'read', args: [] }),
    good({ version: 1, tool: 'read', args: null }),
    `${PREFIX}{not json`,
    `${PREFIX}`,
    `${PREFIX}null`,
    'read',
    '',
    null,
    undefined,
    42,
  ]
  for (const token of rejected) {
    assert.equal(decodeContinuation(token), undefined, `accepted ${JSON.stringify(token)}`)
  }
})

test('the byte cap is exact and measured in UTF-8 bytes', () => {
  const atCap = (pad: number): string =>
    `${PREFIX}${JSON.stringify({ version: 1, tool: 'read', args: { pad: 'x'.repeat(pad) } })}`
  const empty = atCap(0)
  const token = atCap(8192 - Buffer.byteLength(empty))
  assert.equal(Buffer.byteLength(token), 8192)
  assert.equal(decodeContinuation(token)?.tool, 'read')
  assert.equal(decodeContinuation(`${token} `), undefined)
  // A multi-byte character counts its bytes, not its length: 4096 `é` are 8192 bytes.
  const wide = `${PREFIX}${JSON.stringify({ version: 1, tool: 'é'.repeat(4096), args: {} })}`
  assert.ok(Buffer.byteLength(wide) > 8192)
  assert.equal(decodeContinuation(wide), undefined)
})

test('record and count refuse what is not data', () => {
  assert.deepEqual(record({ a: 1 }), { a: 1 })
  for (const value of [undefined, null, [], 'x', 7, true]) assert.equal(record(value), undefined)
  assert.equal(count(7), 7)
  assert.equal(count(0), 0)
  for (const value of [undefined, null, -1, 1.5, '7', Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(count(value), 0, `count(${String(value)}) should read as zero`)
  }
})

test('the barrel exposes every part of the PTC surface', async () => {
  assert.equal(barrel.toOutcome, toOutcome)
  assert.equal(barrel.continuationFor, continuationFor)
  assert.equal(barrel.decodeContinuation, decodeContinuation)
  assert.equal(barrel.continuationForTool('grep', { pattern: 'x' }, {
    status: 'partial',
    effectState: 'none',
    retry: 'never',
    message: 'stopped early',
  }), undefined)
  // The JS helper is a `%load`-able script, not a module: it has no `export`, so it cannot be a barrel
  // export. What the barrel hands out instead is its path and the loader that reaches it.
  assert.match(barrel.OPS_JS_PATH, /ptc[\\/]js[\\/]ops\.mjs$/)
  assert.match(barrel.OPS_PY_PATH, /ptc[\\/]py[\\/]ops\.py$/)
  assert.equal(typeof barrel.createHint, 'function')
  assert.equal(typeof barrel.attachOps, 'function')
  assert.equal(typeof barrel.resetOpsAttachment, 'function')
  assert.equal(await barrel.installPrelude(undefined), 'none')
})
