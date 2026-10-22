/**
 * The PTC projection: the same facts the honesty rules wrote, read back into a type. It is a
 * projection and never a second opinion — `details['outcome.v1']` decides, and the raw observation
 * is only consulted when there are no facts at all.
 */
import { errorPolicy } from '../kernel/errors.ts'
import type { CoverageMeta, EffectState, Outcome } from '../kernel/outcome.ts'
import { OUTCOME_KEY, readOutcome, type ToolObservation } from '../host/contracts.ts'
import {
  continuationFor as continuationFromObservation,
  continuationForTool,
  MAX_TOKEN_BYTES,
  PREFIX,
} from './continuation.ts'
import { count, record, type CanonicalData, type JsonValue } from './types.ts'

/** The encoder lives with the cursor logic; this module only names it once, never re-implements it. */
export { encode } from './continuation.ts'

/** A document is not a graph: past this depth a value is unreadable, so its key is dropped. */
const MAX_DEPTH = 256
const EFFECT_STATES: Readonly<Record<string, true>> = { none: true, applied: true, partial: true, unknown: true }
/** The cause of a truncation, keyed by every spelling the kernel uses for it. */
const TRUNCATIONS: Readonly<Record<string, NonNullable<CoverageMeta['truncatedBy']>>> = {
  'scan-budget': 'scan-budget',
  'output-budget': 'output-budget',
  'time-limit': 'time-limit',
  'row-limit': 'row-limit',
  // `SearchExecutionReport` spells the time budget `time`; same cause, second spelling.
  time: 'time-limit',
}

/** `undefined` means "drop this key": the value cannot be represented, and a lie is worse than a gap. */
function project(value: unknown, ancestors: Set<object>, depth: number): JsonValue | undefined {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  // bigint, function, symbol and undefined have no JSON spelling, so they are dropped rather than
  // stringified into something the caller would have to guess at.
  if (typeof value !== 'object') return undefined
  if (depth >= MAX_DEPTH || ancestors.has(value)) return undefined
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const items: JsonValue[] = []
      for (const item of value) {
        const kept = project(item, ancestors, depth + 1)
        if (kept !== undefined) items.push(kept)
      }
      return items
    }
    return projectFields(value as Record<string, unknown>, ancestors, depth)
  } finally {
    ancestors.delete(value)
  }
}

function projectFields(source: Record<string, unknown>, ancestors: Set<object>, depth: number): CanonicalData {
  const data: CanonicalData = {}
  for (const key of Object.keys(source)) {
    // The facts become typed fields below. Keeping the raw envelope too would leave two statements
    // of the same truth inside one object, free to disagree.
    if (key === OUTCOME_KEY) continue
    // Reading a property may itself throw (a hostile getter); an unreadable value is a dropped key.
    let raw: unknown
    try {
      raw = source[key]
    } catch {
      continue
    }
    const kept = project(raw, ancestors, depth + 1)
    if (kept !== undefined) data[key] = kept
  }
  return data
}

/**
 * `data` is the JSON-clean projection of the observation: the tool's own details, plus the identity
 * of the call. A details value that is not a named object (a bare array, a string) has nothing a
 * consumer could address by name, so only the identity survives.
 */
function dataOf(o: ToolObservation): CanonicalData {
  const details = record(o.details)
  const data = details === undefined ? {} : projectFields(details, new Set<object>([details]), 0)
  data.tool = o.tool
  if (typeof o.callId === 'string' && o.callId.length > 0) data.callId = o.callId
  return data
}

/** An unrecognised effect state is not a mild one: effects we cannot name are effects we cannot bound. */
function effectStateOf(value: unknown): EffectState {
  return typeof value === 'string' && EFFECT_STATES[value] === true ? (value as EffectState) : 'unknown'
}

/**
 * Rebuilds coverage from fields we understand. `readOutcome` validates the four fields that decide
 * the branch, not `coverage`, so a fact may carry counts we cannot read; those read as zero and an
 * `isComplete` that is not literally `true` is not a completeness claim.
 */
function coverageOf(raw: unknown): CoverageMeta | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const truncatedBy = typeof value.truncatedBy === 'string' ? TRUNCATIONS[value.truncatedBy] : undefined
  return {
    scannedFiles: count(value.scannedFiles),
    matchedCount: count(value.matchedCount),
    isComplete: value.isComplete === true,
    ...(truncatedBy === undefined ? {} : { truncatedBy }),
  }
}

/** The four legal retry advices. Anything else is not advice, so it is not carried. */
const RETRY_POLICIES: Readonly<Record<string, true>> = {
  never: true,
  'after-input-change': true,
  'after-state-change': true,
  'bounded-transient': true,
}

/**
 * A failure is never hand-shaped: `errorPolicy` owns the pair `(status, retry)`, and the facts supply
 * the code and the effect state.
 *
 * `publishedRetry` is the one exception, and it exists because `errorPolicy` cannot express it. The
 * kernel documents exactly one producer-side override — a shell command that exited non-zero keeps
 * `effectState: 'unknown'` while advising `after-input-change` — and `errorPolicy(code, 'unknown')`
 * collapses every unknown effect to `never`. Recomputing from the code alone would therefore discard
 * the only retry advice the producer is allowed to refine. A published value is honoured only when it
 * is one of the four legal advices; otherwise the policy answers.
 */
function failure(
  data: CanonicalData,
  code: string,
  message: string,
  effectState: EffectState,
  nextAction?: string,
  publishedRetry?: unknown,
): Outcome<CanonicalData> {
  const policy = errorPolicy(code, effectState)
  const retry = typeof publishedRetry === 'string' && RETRY_POLICIES[publishedRetry] === true
    ? (publishedRetry as typeof policy.retry)
    : policy.retry
  return {
    status: policy.status,
    error: { code, effectState, retry, message, ...(nextAction === undefined ? {} : { nextAction }) },
    data,
  }
}

/**
 * Where an incomplete observation may be continued from — expressed as a token because the frozen
 * `Outcome` type stores one. The cursor logic lives in `continuation.ts`, which owns the encoder and
 * consults the observation itself: a `read` page is named by `details.meta.truncation.nextOffset`
 * and a `grep` file page by `details.fileLimitReached`, and every other shape answers `undefined`
 * because "we stopped early" is not the claim "here is the rest".
 *
 * This positional form is the shape the barrel and existing callers speak, but it carries no
 * `details`, so it can never prove a cursor and always answers `undefined`. `toOutcome` calls the
 * observation-aware form directly; a caller holding an observation must do the same.
 */
export const continuationFor = continuationForTool

/**
 * Reads a token produced by `continuationFor` without trusting a byte of it: any prefix, size,
 * version, tool or args problem means the token is not a v1 retrieval and the caller must treat the
 * observation as having no continuation. Never throws — a token arrives from model output.
 */
export function decodeContinuation(token: unknown): { version: 1, tool: string, args: CanonicalData } | undefined {
  try {
    if (typeof token !== 'string' || !token.startsWith(PREFIX)) return undefined
    if (Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) return undefined
    const value = record(JSON.parse(token.slice(PREFIX.length)) as unknown)
    if (value === undefined || value.version !== 1) return undefined
    const tool = value.tool
    if (typeof tool !== 'string' || tool.length === 0) return undefined
    const args = record(value.args)
    if (args === undefined) return undefined
    return { version: 1, tool, args }
  } catch {
    return undefined
  }
}

/**
 * The typed projection of one `tool_result`. The order of the three cases is the contract:
 * published facts first, then an unclassified failure, then a clean observation.
 */
export function toOutcome(o: ToolObservation): Outcome<CanonicalData> {
  const data = dataOf(o)
  const facts = readOutcome(o.details)

  if (facts !== undefined) {
    const coverage = coverageOf(facts.coverage)
    const nextAction = typeof facts.nextAction === 'string' && facts.nextAction.length > 0 ? facts.nextAction : undefined
    // `completed` with coverage that is absent or literally complete is a completion claim we can
    // carry. Coverage that says otherwise contradicts the status, and the weaker claim is the true
    // one, so the fact falls through to the incomplete path below.
    if (facts.status === 'completed' && (coverage === undefined || coverage.isComplete)) {
      return { status: 'completed', data, ...(coverage === undefined ? {} : { coverage: { ...coverage, isComplete: true as const } }) }
    }
    if (facts.status === 'completed' || facts.status === 'partial') {
      // `partial` needs recordable coverage and a continuation, because the type says both exist.
      if (coverage !== undefined) {
        const continuation = continuationFromObservation(o, facts)
        if (continuation !== undefined) {
          return { status: 'partial', data, coverage: { ...coverage, isComplete: false as const }, continuation }
        }
      }
      return failure(
        data,
        'RESULT_PARTIAL',
        'The observation is incomplete and has no safe continuation; refine the request instead of retrying it.',
        effectStateOf(facts.effectState),
        nextAction,
        facts.retry,
      )
    }
    return failure(data, typeof facts.code === 'string' && facts.code.length > 0 ? facts.code : 'RESULT_UNKNOWN',
      facts.message, effectStateOf(facts.effectState), nextAction, facts.retry)
  }

  if (o.isError) {
    // No rule classified this failure, which is exactly the case where no one has proven what it
    // touched: it may have written before it failed. The only honest advice for an unbounded effect
    // is `never`, so the code and the effect state are both unknown and `errorPolicy` answers
    // `unknown`/`never` for us rather than us spelling it out here.
    return failure(data, 'RESULT_UNKNOWN',
      'The failure carried no outcome facts, so its effects cannot be proven; inspect the raw result before any recovery.',
      'unknown')
  }

  // Success without coverage accounting is not a claim of completeness, so there is no `coverage`
  // key: absence of evidence must not read as evidence of a full scan.
  return { status: 'completed', data }
}
