import {
  isMutableDetails,
  OUTCOME_KEY,
  readOutcome,
  type OutcomeFacts,
  type ToolObservation,
} from '../host/contracts.ts'
import { bashFacts } from '../host/guards.ts'
import { errorPolicy } from '../kernel/errors.ts'
import type { EffectState } from '../kernel/outcome.ts'
import type { MutableResult, Transform } from '../pipeline.ts'

/**
 * Classifies a failed `bash` result into the kernel's outcome vocabulary.
 *
 * The point of this rule is the one distinction the payload already contains but never states: a
 * non-zero exit, a timeout and a cancellation all leave the filesystem in an unknown state, because
 * the command may have written something before it stopped. Only a refusal is known to have done
 * nothing. `bashFacts` owns the payload grammar; this file only names the conclusion.
 */

interface Failure {
  readonly code: string
  readonly effectState: EffectState
  /** The effect handed to `errorPolicy`; differs from `effectState` only for `EXIT_CODE`. */
  readonly policyEffect: EffectState
  readonly message: string
}

/** The host writes `timeoutSeconds` as a positive number; anything else is not a deadline value. */
function timeoutSeconds(o: ToolObservation): number | undefined {
  if (typeof o.details !== 'object' || o.details === null) return undefined
  const value = (o.details as Record<string, unknown>)['timeoutSeconds']
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return value
}

/** Denial, cancellation, timeout and a non-zero exit, in descending order of certainty. */
function classify(o: ToolObservation): Failure | undefined {
  const facts = bashFacts(o)
  if (facts === undefined) return undefined
  if (facts.denied) {
    return {
      code: 'POLICY_DENIED',
      effectState: 'none',
      policyEffect: 'none',
      message: 'Command was refused before execution; nothing ran, so no files or state changed.',
    }
  }
  if (facts.aborted) {
    return {
      code: 'CANCELLED',
      effectState: 'unknown',
      policyEffect: 'unknown',
      message: 'Command was cancelled mid-run; a write may have succeeded before it stopped, so its effects are unknown.',
    }
  }
  if (facts.timedOut) {
    const seconds = timeoutSeconds(o)
    const after = seconds === undefined ? 'after the deadline' : `after ${seconds}s`
    return {
      code: 'RESULT_UNKNOWN',
      effectState: 'unknown',
      policyEffect: 'unknown',
      message: `Command timed out ${after}; it may have changed files or other state before it was killed, and its effects are unknown.`,
    }
  }
  const exitCode = facts.exitCode
  if (typeof exitCode !== 'number' || exitCode === 0) return undefined
  // The documented `EXIT_CODE` exception: the effect stays unknown (a write may have landed before
  // the exit), but the advice is to inspect the output and correct the command or its inputs.
  // `errorPolicy('EXIT_CODE', 'unknown')` itself collapses to `unknown`/`never` because effects
  // dominate; the kernel comment in `errors.ts` places the exception on the producer, so the
  // lookup is made at the code's own tier while the published effect stays `unknown`.
  return {
    code: 'EXIT_CODE',
    effectState: 'unknown',
    policyEffect: 'none',
    message: `Command exited with code ${exitCode}; any file writes or other side effects before the exit are unknown.`,
  }
}

function factsOf(failure: Failure): OutcomeFacts {
  const policy = errorPolicy(failure.code, failure.policyEffect)
  return {
    status: policy.status,
    effectState: failure.effectState,
    retry: policy.retry,
    code: failure.code,
    message: failure.message,
  }
}

/**
 * Writes the facts where a later reader can find them. A denial and a cancellation reach us with no
 * `details` at all, so for those two shapes this rule installs the container it needs; when another
 * shape supplied details that cannot be edited (frozen, a primitive) the result is left alone.
 */
function publish(out: MutableResult, facts: OutcomeFacts): void {
  if (isMutableDetails(out.details)) {
    if (readOutcome(out.details) !== undefined) return
    out.details[OUTCOME_KEY] = facts
    return
  }
  if (out.details === undefined || out.details === null) {
    out.details = { [OUTCOME_KEY]: facts }
  }
}

export const transform: Transform = {
  name: 'rules/bash',
  features: ['honesty'],
  apply(o, out) {
    const failure = classify(o)
    if (failure === undefined) return
    publish(out, factsOf(failure))
  },
}
