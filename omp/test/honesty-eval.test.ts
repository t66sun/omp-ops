import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OUTCOME_KEY,
  isMutableDetails,
  readOutcome,
  type OutcomeFacts,
  type ToolObservation,
} from '../src/host/contracts.ts'
import { errorPolicy } from '../src/kernel/errors.ts'
import type { MutableResult, Transform } from '../src/pipeline.ts'
import { transform } from '../src/rules/eval.ts'

/**
 * Every payload below is copied from an omp 18.12.6 `tool_result` captured by a throwaway extension
 * that logged `eval` calls only (see the slice report). `details.cells` is the only structure the
 * rule reads, and `durationMs` / titles are kept because a real payload has them.
 */
const observation = (details: unknown, content: string, isError: boolean, tool = 'eval'): ToolObservation => ({
  tool,
  args: {},
  content: [{ type: 'text', text: content }],
  details,
  isError,
})

/** Each test gets its own copy: the rule mutates `details` in place, exactly as the host would. */
const result = (details: unknown, content = ''): MutableResult => ({
  content: [{ type: 'text', text: content }],
  details: structuredClone(details),
  isError: true,
})

const THROWN = {
  language: 'python',
  languages: ['python'],
  cells: [{
    index: 0,
    title: 'Probe runtime error',
    code: "raise RuntimeError('probe-boom-a')",
    language: 'python',
    output: 'Traceback (most recent call last):\n  File "<cell>", line 1, in <module>\nRuntimeError: probe-boom-a',
    status: 'error',
    exitCode: 1,
    durationMs: 881,
  }],
  isError: true,
}
const THROWN_TEXT = 'Traceback (most recent call last):\n  File "<cell>", line 1, in <module>\nRuntimeError: probe-boom-a\n\nCommand exited with code 1'

const TIMEOUT = {
  language: 'python',
  languages: ['python'],
  cells: [{
    index: 0,
    title: 'Timeout param probe',
    code: 'import time; time.sleep(120)',
    language: 'python',
    output: '[eval cell timed out and the kernel was unresponsive to interrupt; the kernel has been killed and will be recreated on the next call.]\n[kernel] Python kernel exited with code 130',
    status: 'error',
    durationMs: 2007,
  }],
  isError: true,
}
const TIMEOUT_TEXT = '[eval cell timed out and the kernel was unresponsive to interrupt; the kernel has been killed and will be recreated on the next call.]\n[kernel] Python kernel exited with code 130'

const DIED = {
  language: 'python',
  languages: ['python'],
  cells: [{
    index: 0,
    title: 'Sending SIGINT to the python kernel',
    code: 'import os, signal; os.kill(os.getpid(), signal.SIGINT)',
    language: 'python',
    output: '[Kernel died during execution; completion is uncertain. The cell was not replayed; check for partial side effects before retrying.]\n[kernel] Python kernel exited with code 2',
    status: 'error',
    durationMs: 230,
  }],
  isError: true,
}
const DIED_TEXT = '[Kernel died during execution; completion is uncertain. The cell was not replayed; check for partial side effects before retrying.]\n[kernel] Python kernel exited with code 2'

const WORKER_EXIT = {
  language: 'js',
  languages: ['js'],
  cells: [{
    index: 0,
    title: 'Run process.exit(3)',
    code: 'process.exit(3)',
    language: 'js',
    output: 'Error: JS eval worker exited with code 3\n    at <anonymous> (B:/~BUN/root/chunks/cli-v3znx17a.js:139:28)',
    status: 'error',
    exitCode: 1,
    durationMs: 64,
  }],
  isError: true,
}
const WORKER_EXIT_TEXT = 'Error: JS eval worker exited with code 3\n    at <anonymous> (B:/~BUN/root/chunks/cli-v3znx17a.js:139:28)\n\nCommand exited with code 1'

const SUCCESS = {
  language: 'python',
  languages: ['python'],
  cells: [{
    index: 0,
    title: 'Running print(6*7)',
    code: 'print(6*7)',
    language: 'python',
    output: '42',
    status: 'complete',
    exitCode: 0,
    durationMs: 222,
  }],
}

const FACT_CASES: readonly { name: string, details: unknown, content: string }[] = [
  { name: 'a cell that threw in a surviving kernel', details: THROWN, content: THROWN_TEXT },
  { name: 'a cell that exceeded its timeout', details: TIMEOUT, content: TIMEOUT_TEXT },
  { name: 'a kernel that died mid-cell', details: DIED, content: DIED_TEXT },
  { name: 'a JS worker that exited mid-cell', details: WORKER_EXIT, content: WORKER_EXIT_TEXT },
]

const factsOf = (details: unknown, content: string): OutcomeFacts => {
  const out = result(details, content)
  transform.apply(observation(details, content, true), out)
  const facts = readOutcome(out.details)
  assert.notEqual(facts, undefined, 'expected the rule to publish outcome.v1')
  return facts!
}

test('declares the frozen identity of the eval rule', () => {
  const identity: Transform = transform
  assert.equal(identity.name, 'rules/eval')
  assert.deepEqual(identity.features, ['honesty'])
})

for (const { name, details, content } of FACT_CASES) {
  test(`${name} reports RESULT_UNKNOWN / unknown and the policy's retry`, () => {
    const facts = factsOf(details, content)
    const policy = errorPolicy('RESULT_UNKNOWN', 'unknown')
    assert.equal(facts.code, 'RESULT_UNKNOWN')
    assert.equal(facts.effectState, 'unknown')
    assert.equal(facts.status, policy.status)
    assert.equal(facts.retry, policy.retry)
    assert.equal(facts.status, 'unknown')
    // Effects are unknown, so the kernel must never license a replay, whatever the code says.
    assert.equal(facts.retry, 'never')
    assert.ok(facts.message.length > 0)
  })

  test(`${name} leaves out.content byte-identical`, () => {
    const out = result(details, content)
    const before = JSON.stringify(out.content)
    const isError = out.isError
    transform.apply(observation(details, content, true), out)
    assert.equal(JSON.stringify(out.content), before)
    assert.equal(out.isError, isError)
  })
}

test('the four observed failure kinds stay distinguishable in the message', () => {
  const messages = FACT_CASES.map(({ details, content }) => factsOf(details, content).message)
  assert.equal(new Set(messages).size, messages.length)
  assert.match(factsOf(TIMEOUT, TIMEOUT_TEXT).message, /deadline/)
  assert.match(factsOf(DIED, DIED_TEXT).message, /kernel died/)
  assert.match(factsOf(WORKER_EXIT, WORKER_EXIT_TEXT).message, /worker exited/)
})

test('no failure path advises a replay', () => {
  for (const { details, content } of FACT_CASES) {
    const facts = factsOf(details, content)
    assert.equal(facts.retry, 'never')
    assert.doesNotMatch(facts.message, /retry|replay|re-run|rerun|again/i)
    assert.doesNotMatch(facts.nextAction ?? '', /retry|replay|re-run|rerun|again/i)
  }
})

test('a successful cell writes nothing at all', () => {
  const out = result(SUCCESS, '42')
  out.isError = false
  const before = JSON.stringify({ content: out.content, details: out.details })
  transform.apply(observation(SUCCESS, '42', false), out)
  assert.equal(JSON.stringify({ content: out.content, details: out.details }), before)
  assert.equal((out.details as Record<string, unknown>)[OUTCOME_KEY], undefined)
})

test('a successful cell that the host still flagged with details.isError is a failure', () => {
  const facts = factsOf(SUCCESS, '42')
  assert.equal(facts.code, 'RESULT_UNKNOWN')
})

test('a bash observation is ignored even when it failed', () => {
  const details = { wallTimeNoticeEmitted: false, timeoutSeconds: 60, wallTimeMs: 76.6, exitCode: 3 }
  const out = result(details, 'out\n\n\nCommand exited with code 3')
  transform.apply(observation(details, 'out\n\n\nCommand exited with code 3', true, 'bash'), out)
  assert.equal((out.details as Record<string, unknown>)[OUTCOME_KEY], undefined)
})

test('a read observation is ignored even when it failed', () => {
  const details = { truncation: { truncated: true, truncatedBy: 'lines' }, totalLines: 54 }
  const out = result(details, 'lines')
  transform.apply(observation(details, 'lines', true, 'read'), out)
  assert.equal((out.details as Record<string, unknown>)[OUTCOME_KEY], undefined)
})

test('a task spawn receipt is ignored', () => {
  const details = {
    projectAgentsDir: null,
    results: [],
    totalDurationMs: 1,
    progress: [{ index: 0, id: 'PoisedWhippet', agent: 'task', status: 'pending' }],
    async: { state: 'running', jobId: 'PoisedWhippet', type: 'task' },
  }
  const out = result(details, 'Spawned agent `PoisedWhippet` (job `PoisedWhippet`).')
  out.isError = false
  transform.apply(observation(details, 'Spawned agent `PoisedWhippet` (job `PoisedWhippet`).', false, 'task'), out)
  assert.equal((out.details as Record<string, unknown>)[OUTCOME_KEY], undefined)
})

test('an existing outcome.v1 is not overwritten', () => {
  const existing: OutcomeFacts = {
    status: 'rejected',
    effectState: 'none',
    retry: 'never',
    message: 'another rule already spoke',
    code: 'POLICY_DENIED',
  }
  const details = { ...structuredClone(THROWN), [OUTCOME_KEY]: existing }
  const out: MutableResult = { content: [{ type: 'text', text: THROWN_TEXT }], details, isError: true }
  transform.apply(observation(details, THROWN_TEXT, true), out)
  assert.equal((out.details as Record<string, unknown>)[OUTCOME_KEY], existing)
  assert.deepEqual(readOutcome(out.details), existing)
})

test('applying twice does not publish a second, different fact', () => {
  const out = result(THROWN, THROWN_TEXT)
  transform.apply(observation(THROWN, THROWN_TEXT, true), out)
  const first = (out.details as Record<string, unknown>)[OUTCOME_KEY]
  transform.apply(observation(THROWN, THROWN_TEXT, true), out)
  assert.equal((out.details as Record<string, unknown>)[OUTCOME_KEY], first)
})

test('a failure whose details are not an eval record is left alone', () => {
  const shapes: unknown[] = [
    undefined,
    null,
    'boom',
    [],
    {},
    { language: 'python' },
    { cells: [] },
    { cells: 'not-an-array' },
    { cells: [{ output: 'no status' }], isError: true },
  ]
  for (const details of shapes) {
    const out = result(details, 'Error: something')
    transform.apply(observation(details, 'Error: something', true), out)
    const published = isMutableDetails(out.details) ? out.details[OUTCOME_KEY] : undefined
    assert.equal(published, undefined, `unexpected facts for ${JSON.stringify(details)}`)
  }
})

test('frozen details are never written to and never throw', () => {
  const details = Object.freeze(structuredClone(THROWN))
  const out: MutableResult = { content: [{ type: 'text', text: THROWN_TEXT }], details, isError: true }
  transform.apply(observation(details, THROWN_TEXT, true), out)
  assert.equal(out.details, details)
  assert.equal((details as Record<string, unknown>)[OUTCOME_KEY], undefined)
})
