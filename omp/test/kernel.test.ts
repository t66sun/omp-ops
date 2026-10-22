import assert from 'node:assert/strict'
import { test } from 'node:test'
import { coverageOf } from '../src/kernel/coverage.ts'
import { ERROR_POLICIES, errorPolicy } from '../src/kernel/errors.ts'

test('an unknown or restricted receipt never licenses a retry', () => {
  assert.deepEqual(errorPolicy('RESULT_UNKNOWN'), { status: 'unknown', retry: 'never' })
  assert.deepEqual(errorPolicy('EXECUTION_RESTRICTED'), { status: 'unknown', retry: 'never' })
  assert.deepEqual(errorPolicy('EXIT_CODE', 'unknown'), { status: 'unknown', retry: 'never' })
})

test('invalid input asks for corrected input, not a replay', () => {
  assert.deepEqual(errorPolicy('INVALID_ARGUMENT'), { status: 'error', retry: 'after-input-change' })
})

test('an observed effect dominates the table advice', () => {
  assert.deepEqual(errorPolicy('INVALID_ARGUMENT', 'applied'), { status: 'error', retry: 'never' })
  assert.deepEqual(errorPolicy('JOB_BUSY', 'applied'), { status: 'error', retry: 'never' })
})

test('an unlisted code falls back to a settled error', () => {
  assert.deepEqual(errorPolicy('NOT_A_REAL_CODE'), { status: 'error', retry: 'never' })
})

test('the policy table is frozen and keeps its documented entries', () => {
  assert.equal(Object.isFrozen(ERROR_POLICIES), true)
  assert.equal(Object.isFrozen(ERROR_POLICIES.REVISION_CONFLICT), true)
  assert.deepEqual(errorPolicy('CALL_LIMIT'), { status: 'error', retry: 'after-state-change' })
  assert.deepEqual(errorPolicy('JOB_BUSY'), { status: 'error', retry: 'bounded-transient' })
  assert.deepEqual(errorPolicy('REVISION_CONFLICT'), { status: 'conflict', retry: 'after-state-change' })
  assert.deepEqual(errorPolicy('RESULT_PARTIAL'), { status: 'error', retry: 'never' })
})

test('a complete scan never claims a truncation reason', () => {
  const complete = coverageOf({
    scannedFiles: 3,
    matchedCount: 5,
    scanComplete: true,
    truncatedBy: 'output-budget',
  })
  assert.deepEqual(complete, { scannedFiles: 3, matchedCount: 5, isComplete: true })
  assert.equal('truncatedBy' in complete, false)
})

test('an incomplete scan keeps the reason it was given', () => {
  assert.deepEqual(coverageOf({ scannedFiles: 3, matchedCount: 2, scanComplete: false, truncatedBy: 'scan-budget' }), {
    scannedFiles: 3,
    matchedCount: 2,
    isComplete: false,
    truncatedBy: 'scan-budget',
  })
  assert.deepEqual(coverageOf({ scannedFiles: 3, matchedCount: 2, scanComplete: false }), {
    scannedFiles: 3,
    matchedCount: 2,
    isComplete: false,
  })
})
