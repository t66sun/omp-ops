import { readOutcome, isMutableDetails, OUTCOME_KEY, type OutcomeFacts, type ToolObservation } from '../host/contracts.ts'
import { errorPolicy } from '../kernel/errors.ts'
import type { Transform } from '../pipeline.ts'

/**
 * How an `eval` call failed, as far as the observed payload can tell. Every failure is uncertain
 * about effects — a cell can write a file on line 1 and throw on line 2 — so the kinds differ only
 * in what they can say about the kernel, never in whether a replay is safe.
 */
type EvalFailure = 'threw' | 'timeout' | 'died' | 'worker-exit'

const CODE = 'RESULT_UNKNOWN'
const EFFECT = 'unknown'

const MESSAGES: Record<EvalFailure, { message: string; nextAction: string }> = {
  threw: {
    message: 'The eval cell threw after it started; anything it wrote before the error is unknown.',
    nextAction: 'Check what the cell may have written before it threw, then decide what to run next.',
  },
  timeout: {
    message: 'The eval cell exceeded its deadline and the kernel was killed; anything the cell wrote before the deadline is unknown.',
    nextAction: 'Check what the cell may have written before the deadline; the kernel was killed and its in-memory state is gone.',
  },
  died: {
    message: 'The eval kernel died while running the cell; whether the cell finished its work is unknown.',
    nextAction: 'Check what the cell may have written before the kernel died; the in-memory state is gone.',
  },
  'worker-exit': {
    message: 'The JS eval worker exited while running the cell; whether the cell finished its work is unknown.',
    nextAction: 'Check what the cell may have written before the worker exited; that runtime state is gone.',
  },
}

/**
 * Ordered text sentinels, copied from omp 18.12.6 payloads. The timeout message also carries the
 * kernel-exit line, so it has to win over the death sentinel; a JS worker exit arrives without any
 * `[kernel]` line at all.
 */
const SENTINELS: readonly (readonly [RegExp, EvalFailure])[] = [
  [/cell timed out/i, 'timeout'],
  [/eval worker exited with code/i, 'worker-exit'],
  [/kernel died during execution/i, 'died'],
  [/\[kernel\][^\n]*exited with code/i, 'died'],
]

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const part of value) {
    const text = asRecord(part)?.['text']
    if (typeof text === 'string') parts.push(text)
  }
  return parts.join('\n')
}

/** Every cell record with its `status` and `output`, or `undefined` when this is not an eval record. */
function cells(details: Record<string, unknown>): readonly Record<string, unknown>[] | undefined {
  const raw = details['cells']
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const out: Record<string, unknown>[] = []
  for (const entry of raw) {
    const cell = asRecord(entry)
    // The host always prints a status per cell; a record without one is not an eval payload.
    if (cell === undefined || typeof cell['status'] !== 'string') return undefined
    out.push(cell)
  }
  return out
}

function failureKind(text: string): EvalFailure {
  for (const [pattern, kind] of SENTINELS) if (pattern.test(text)) return kind
  return 'threw'
}

/**
 * Classifies an `eval` result, or returns `undefined` for anything else. A successful cell carries
 * `status: 'complete'`, no top-level `isError` and no sentinel, so it gets no facts at all.
 *
 * A failure without a recognisable `details.cells` record is left alone rather than guessed at:
 * validation errors and denials that never reached the kernel were not observed, and a rule that
 * invents an effect state for them is worse than one that stays silent.
 */
function classify(o: ToolObservation): OutcomeFacts | undefined {
  if (o.tool !== 'eval') return undefined
  const details = asRecord(o.details)
  if (details === undefined) return undefined
  const recorded = cells(details)
  if (recorded === undefined) return undefined

  const failed = o.isError || details['isError'] === true || recorded.some((cell) => cell['status'] === 'error')
  if (!failed) return undefined

  const text = [textOf(o.content), ...recorded.map((cell) => textOf(cell['output']))].join('\n')
  const kind = failureKind(text)
  const policy = errorPolicy(CODE, EFFECT)
  return {
    status: policy.status,
    effectState: EFFECT,
    retry: policy.retry,
    message: MESSAGES[kind].message,
    code: CODE,
    nextAction: MESSAGES[kind].nextAction,
  }
}

/** Publishes what an `eval` failure can honestly say: effects unknown, so replay is never advised. */
export const transform: Transform = {
  name: 'rules/eval',
  features: ['honesty'],
  apply(o, out) {
    if (!isMutableDetails(out.details)) return
    if (readOutcome(out.details) !== undefined) return
    const facts = classify(o)
    if (facts === undefined) return
    out.details[OUTCOME_KEY] = facts
  },
}
