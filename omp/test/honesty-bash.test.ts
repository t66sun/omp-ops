import assert from 'node:assert/strict'
import test from 'node:test'
import {
  OUTCOME_KEY,
  type OutcomeFacts,
  type ToolObservation,
} from '../src/host/contracts.ts'
import { errorPolicy } from '../src/kernel/errors.ts'
import { transform } from '../src/rules/bash.ts'
import type { MutableResult } from '../src/pipeline.ts'

/** Fixtures copied from the live omp 18.12.6 payloads captured in `docs/porting/spike-report.md`. */
const SUCCESS_DETAILS = { wallTimeNoticeEmitted: false, timeoutSeconds: 60, wallTimeMs: 85.4844 }
const NONZERO_DETAILS = { wallTimeNoticeEmitted: false, timeoutSeconds: 60, wallTimeMs: 76.6034, exitCode: 3 }
const TIMEOUT_DETAILS = { wallTimeNoticeEmitted: true, timeoutSeconds: 3, wallTimeMs: 3166.3081, timedOut: true }

function observation(over: Partial<ToolObservation> = {}): ToolObservation {
  return {
    tool: 'bash',
    args: { command: 'echo out; exit 3' },
    content: [{ type: 'text', text: 'out\n\n\nCommand exited with code 3' }],
    details: { ...NONZERO_DETAILS },
    isError: true,
    ...over,
  }
}

function run(o: ToolObservation): MutableResult {
  const out: MutableResult = { content: [...o.content], details: o.details, isError: o.isError }
  transform.apply(o, out)
  return out
}

function outcomeOf(out: MutableResult): OutcomeFacts | undefined {
  if (typeof out.details !== 'object' || out.details === null) return undefined
  return (out.details as Record<string, unknown>)[OUTCOME_KEY] as OutcomeFacts | undefined
}

function failureOf(o: ToolObservation): OutcomeFacts {
  const facts = outcomeOf(run(o))
  assert.ok(facts !== undefined, 'expected the bash rule to publish outcome.v1')
  return facts
}

test('declares the frozen identity of the bash rule', () => {
  assert.equal(transform.name, 'rules/bash')
  assert.deepEqual(transform.features, ['honesty'])
})

test('a non-zero exit keeps the effect unknown but licenses a corrected replay', () => {
  const facts = failureOf(observation())
  assert.equal(facts.code, 'EXIT_CODE')
  assert.equal(facts.status, 'error')
  assert.equal(facts.effectState, 'unknown')
  assert.equal(facts.retry, 'after-input-change')
  assert.match(facts.message, /code 3/)
  assert.match(facts.message, /unknown/i)
  assert.ok(facts.message.length <= 140, facts.message)
})

test('the replay advice is the documented EXIT_CODE exception, derived from the kernel', () => {
  const facts = failureOf(observation())
  // Effects dominate the generic lookup, so the producer applies the code's own tier.
  assert.deepEqual(errorPolicy('EXIT_CODE', 'unknown'), { status: 'unknown', retry: 'never' })
  assert.deepEqual(errorPolicy('EXIT_CODE'), { status: 'error', retry: 'after-input-change' })
  assert.equal(facts.effectState, 'unknown')
  assert.equal(facts.retry, errorPolicy('EXIT_CODE').retry)
})

test('a timeout is RESULT_UNKNOWN with no replay, never EXIT_CODE', () => {
  const facts = failureOf(observation({
    details: { ...TIMEOUT_DETAILS },
    content: [{ type: 'text', text: '[Command timed out after 3 seconds]\nerror: interrupted' }],
  }))
  assert.equal(facts.code, 'RESULT_UNKNOWN')
  assert.equal(facts.status, 'unknown')
  assert.equal(facts.effectState, 'unknown')
  assert.equal(facts.retry, 'never')
  assert.notEqual(facts.code, 'EXIT_CODE')
  assert.match(facts.message, /3s/)
  assert.match(facts.message, /unknown/i)
  assert.ok(facts.message.length <= 140, facts.message)
})

test('a timeout is not reclassified as EXIT_CODE even if the host also reports an exit code', () => {
  const facts = failureOf(observation({ details: { ...TIMEOUT_DETAILS, exitCode: 137 } }))
  assert.equal(facts.code, 'RESULT_UNKNOWN')
  assert.equal(facts.effectState, 'unknown')
  assert.equal(facts.retry, 'never')
})

test('a timeout without a usable timeoutSeconds still names the deadline without inventing a value', () => {
  const withoutSeconds = { wallTimeNoticeEmitted: true, wallTimeMs: 3166.3081, timedOut: true }
  const facts = failureOf(observation({ details: withoutSeconds }))
  assert.equal(facts.code, 'RESULT_UNKNOWN')
  assert.equal(facts.effectState, 'unknown')
  assert.doesNotMatch(facts.message, /undefined|NaN/)
  assert.ok(facts.message.length <= 140, facts.message)
})

test('a mid-run cancellation is CANCELLED, never EXIT_CODE', () => {
  const facts = failureOf(observation({
    details: undefined,
    content: [{ type: 'text', text: '[Command aborted]' }],
  }))
  assert.equal(facts.code, 'CANCELLED')
  assert.equal(facts.status, 'unknown')
  assert.equal(facts.effectState, 'unknown')
  assert.equal(facts.retry, 'never')
  assert.notEqual(facts.code, 'EXIT_CODE')
  assert.match(facts.message, /cancelled mid-run/)
  assert.ok(facts.message.length <= 140, facts.message)
})

test('a refusal is rejected with no effect and no replay', () => {
  const facts = failureOf(observation({
    details: undefined,
    content: [{
      type: 'text',
      text: 'Tool "bash" requires approval but no interactive UI available.\nOptions:\n  1. Set tools.approvalMode: yolo in /settings',
    }],
  }))
  assert.equal(facts.code, 'POLICY_DENIED')
  assert.equal(facts.status, 'rejected')
  assert.equal(facts.effectState, 'none')
  assert.equal(facts.retry, 'never')
  assert.match(facts.message, /refused before execution/)
  assert.match(facts.message, /nothing ran/)
  assert.ok(facts.message.length <= 140, facts.message)
})

test('a successful command writes nothing at all', () => {
  const details = { ...SUCCESS_DETAILS }
  const out = run(observation({
    details,
    isError: false,
    content: [{ type: 'text', text: 'out' }],
  }))
  assert.equal(outcomeOf(out), undefined)
  assert.equal(OUTCOME_KEY in details, false)
  assert.deepEqual(Object.keys(details), Object.keys(SUCCESS_DETAILS))
})

test('an explicit exit code zero is not a failure', () => {
  const out = run(observation({
    details: { ...SUCCESS_DETAILS, exitCode: 0 },
    isError: false,
  }))
  assert.equal(outcomeOf(out), undefined)
})

test('a non-bash observation is left alone even when it carries a bash-shaped payload', () => {
  const details = { ...NONZERO_DETAILS }
  const out = run(observation({
    tool: 'read',
    details,
    args: { path: 'omp/src/rules/bash.ts' },
  }))
  assert.equal(outcomeOf(out), undefined)
  assert.deepEqual(details, NONZERO_DETAILS)
})

test('a bash-shaped payload we do not recognise is not classified', () => {
  const out = run(observation({ details: { somethingElse: 1 } }))
  assert.equal(outcomeOf(out), undefined)
})

test('a details-less error without a denial or cancellation message is not classified', () => {
  const out = run(observation({
    details: undefined,
    content: [{ type: 'text', text: 'Command failed: missing exit status' }],
  }))
  assert.equal(outcomeOf(out), undefined)
})

test("another rule's existing outcome.v1 is never overwritten", () => {
  const existing: OutcomeFacts = {
    status: 'rejected',
    effectState: 'none',
    retry: 'never',
    message: 'another rule already decided',
    code: 'POLICY_DENIED',
  }
  const details = { ...NONZERO_DETAILS, [OUTCOME_KEY]: existing }
  const out = run(observation({ details }))
  assert.equal((out.details as Record<string, unknown>)[OUTCOME_KEY], existing)
  assert.deepEqual(out.details, details)
  assert.equal(out.isError, true)
})

test('frozen details are left untouched rather than replaced', () => {
  const details = Object.freeze({ ...NONZERO_DETAILS })
  const out = run(observation({ details }))
  assert.equal(out.details, details)
  assert.deepEqual(details, NONZERO_DETAILS)
})

test('no failure path changes content or isError', () => {
  const cases: ToolObservation[] = [
    observation(),
    observation({ details: { ...TIMEOUT_DETAILS } }),
    observation({ details: undefined, content: [{ type: 'text', text: '[Command aborted]' }] }),
    observation({ details: undefined, content: [{ type: 'text', text: 'Tool "bash" requires approval but no interactive UI available.' }] }),
  ]
  for (const o of cases) {
    const before = structuredClone(o.content)
    const out = run(o)
    assert.deepEqual(out.content, before)
    assert.equal(out.isError, o.isError)
  }
})
