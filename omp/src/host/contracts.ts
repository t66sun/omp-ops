import type { CoverageMeta, EffectState, RetryPolicy } from '../kernel/outcome.ts'

/**
 * One `tool_result` event reduced to the fields every consumer is allowed to read. These are our
 * field names, not the host's: `observe` is the only place that knows the wire shape.
 */
export interface ToolObservation {
  readonly tool: string
  readonly args: unknown
  readonly content: readonly unknown[]
  readonly details: unknown
  readonly isError: boolean
  /**
   * The host's id for this call, when it supplied one. omp has no message id, so a consumer that
   * needs to name where a body already lives names the call and nothing else.
   */
  readonly callId?: string
}

/**
 * Maps the host payload (`toolName`, `input`) onto `ToolObservation` and returns `undefined` for any
 * shape we do not recognise, so callers pass through untouched. Never throws: a malformed payload
 * is a fact to report by returning nothing, not an exception.
 */
export function observe(raw: unknown): ToolObservation | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const candidate = raw as {
    toolName?: unknown
    toolCallId?: unknown
    input?: unknown
    content?: unknown
    details?: unknown
    isError?: unknown
  }
  const { toolName, toolCallId, input, content, details, isError } = candidate
  if (typeof toolName !== 'string') return undefined
  if (!Array.isArray(content)) return undefined
  if (typeof isError !== 'boolean') return undefined
  const body: readonly unknown[] = Object.freeze([...content])
  const callId = typeof toolCallId === 'string' && toolCallId.length > 0 ? toolCallId : undefined
  return Object.freeze({ tool: toolName, args: input, content: body, details, isError, callId })
}

/**
 * Key under which a rule transform publishes what it concluded about a result. The `v1` suffix is
 * part of the contract: a later shape must arrive under a new key so an older renderer keeps
 * working, and a consumer can tell "no opinion" from "opinion I do not understand".
 */
export const OUTCOME_KEY = 'outcome.v1'

/**
 * The single structure the rules write and the renderer reads. It is deliberately the kernel's
 * vocabulary: a rule classifies, it does not invent a second error taxonomy.
 */
export interface OutcomeFacts {
  readonly status: 'completed' | 'partial' | 'rejected' | 'conflict' | 'error' | 'unknown'
  readonly effectState: EffectState
  readonly retry: RetryPolicy
  readonly message: string
  readonly code?: string
  readonly nextAction?: string
  readonly coverage?: CoverageMeta
}

/** True only for a plain mutable object, i.e. something a rule may attach facts to. */
export function isMutableDetails(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Object.isFrozen(value)
}

/**
 * Reads `details[OUTCOME_KEY]` without trusting it: any missing or wrongly-typed field makes the
 * whole thing unrecognised, because a half-understood outcome is worse than none.
 */
export function readOutcome(details: unknown): OutcomeFacts | undefined {
  if (typeof details !== 'object' || details === null) return undefined
  const raw = (details as Record<string, unknown>)[OUTCOME_KEY]
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.status !== 'string' || typeof value.effectState !== 'string') return undefined
  if (typeof value.retry !== 'string' || typeof value.message !== 'string') return undefined
  return raw as OutcomeFacts
}
