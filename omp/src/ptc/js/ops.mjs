/**
 * The `ops` object JavaScript sees inside `eval`.
 *
 * `%load` is the only way an eval kernel can obtain our helpers, and `%load` rejects any file that
 * contains a module `export` ("Unexpected keyword 'export' at <parse>"). So this file is a script,
 * not a module: no imports, no exports, and one name published on the global scope at the end. It
 * is plain JavaScript on purpose — the Bun worker cannot load our TypeScript, so the prelude
 * `%load`s this file by path and nothing else resolves it for us.
 *
 * That makes it a second implementation of the projection in `omp/src/ptc/outcome.ts`, and a second
 * implementation is a drift risk. The parity test in `omp/test/ptc-js.test.ts` is the guard: it
 * compares this file, fixture by fixture, against `toOutcome(observe(raw))`. Change both or neither.
 *
 * One delimiter between the two implementations is deliberate. `toOutcome` receives an observation
 * and may throw at nothing, because its caller has already decided the payload is one; here the raw
 * result is whatever a host tool resolved with, including `undefined`, so an unusable result becomes
 * the same `unknown` outcome an unclassified failure gets instead of a throw.
 */

const OUTCOME_KEY = 'outcome.v1'

/** A document is not a graph: past this depth a value is unreadable, so its key is dropped. */
const MAX_DEPTH = 256

const EFFECT_STATES = new Set(['none', 'applied', 'partial', 'unknown'])
const RETRY_POLICIES = new Set(['never', 'after-input-change', 'after-state-change', 'bounded-transient'])

/** The cause of a truncation, keyed by every spelling the kernel uses for it. */
const TRUNCATIONS = new Map([
  ['scan-budget', 'scan-budget'],
  ['output-budget', 'output-budget'],
  ['time-limit', 'time-limit'],
  ['row-limit', 'row-limit'],
  // `SearchExecutionReport` spells the time budget `time`; same cause, second spelling.
  ['time', 'time-limit'],
])

/** The host's tool names, and the only names `createOps` answers to. */
const OPS_TOOLS = ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'eval', 'task']

const UNCLASSIFIED_MESSAGE =
  'The failure carried no outcome facts, so its effects cannot be proven; inspect the raw result before any recovery.'
const NO_CONTINUATION_MESSAGE =
  'The observation is incomplete and has no safe continuation; refine the request instead of retrying it.'

// ---------------------------------------------------------------------------------------------
// Frozen copy of `omp/src/kernel/errors.ts`.
//
// A copy, never a second source of truth. The kernel is TypeScript this file cannot load, so the
// `(status, retry)` pairs are restated here verbatim and pinned by the parity test, which asserts
// this table against `errorPolicy` for every code it knows. A code added to the kernel is added
// here in the same change.
// ---------------------------------------------------------------------------------------------

const rejected = Object.freeze({ status: 'rejected', retry: 'never' })
const invalid = Object.freeze({ status: 'error', retry: 'after-input-change' })
const changed = Object.freeze({ status: 'error', retry: 'after-state-change' })
const settled = Object.freeze({ status: 'error', retry: 'never' })
const unknown = Object.freeze({ status: 'unknown', retry: 'never' })

const ERROR_POLICIES = Object.freeze({
  POLICY_DENIED: rejected,
  CREDENTIAL_DENIED: rejected,
  PATH_RESTRICTED: rejected,
  REVISION_CONFLICT: Object.freeze({ status: 'conflict', retry: 'after-state-change' }),
  INVALID_ARGUMENT: invalid,
  EDIT_CONFLICT: invalid,
  SEARCH_STALE: invalid,
  NOT_FOUND: invalid,
  IS_DIRECTORY: invalid,
  OUTPUT_LIMIT: invalid,
  CROSS_DEVICE: invalid,
  ERR_INVALID_ENCODING: invalid,
  TABLE_PARSE_ERROR: invalid,
  DOCUMENT_PARSE_ERROR: invalid,
  // The kernel's one documented producer-side exception: a completed shell command that exited
  // nonzero keeps `effectState: 'unknown'` yet advises `after-input-change`.
  EXIT_CODE: invalid,
  UNSUPPORTED_DOCUMENT: settled,
  FILE_CHANGED: changed,
  REFERENCE_EXPIRED: changed,
  AUTHORITY_CHANGED: changed,
  ACCESS_DENIED: changed,
  EXECUTOR_UNAVAILABLE: changed,
  JOB_BUSY: Object.freeze({ status: 'error', retry: 'bounded-transient' }),
  CALL_LIMIT: Object.freeze({ status: 'error', retry: 'after-state-change' }),
  CANCELLED: settled,
  METADATA_UNSUPPORTED: settled,
  LOCK_UNSUPPORTED: settled,
  PATH_CHANGED: changed,
  IO_ERROR: settled,
  SYNC_FAILED: settled,
  CLEANUP_FAILED: settled,
  RESULT_PARTIAL: settled,
  EXECUTION_RESTRICTED: unknown,
  RESULT_UNKNOWN: unknown,
})

/** Effects dominate retry advice: a failed receipt never licenses replaying a possible write. */
function errorPolicy(code, effectState = 'none') {
  if (effectState === 'unknown' || code === 'RESULT_UNKNOWN' || code === 'EXECUTION_RESTRICTED') return unknown
  if (effectState !== 'none') return settled
  return Object.prototype.hasOwnProperty.call(ERROR_POLICIES, code) ? ERROR_POLICIES[code] : settled
}

// ---------------------------------------------------------------------------------------------
// The JSON projection. Identical in shape and in order to `outcome.ts`.
// ---------------------------------------------------------------------------------------------

/** A plain object — not `null`, not an array — i.e. the only thing treated as having named fields. */
function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

/** A count is a non-negative safe integer; unreadable data reads as zero. */
function count(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/** `undefined` means "drop this key": the value cannot be represented, and a lie is worse than a gap. */
function project(value, ancestors, depth) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  // bigint, function, symbol and undefined have no JSON spelling, so they are dropped rather than
  // stringified into something the caller would have to guess at.
  if (typeof value !== 'object') return undefined
  if (depth >= MAX_DEPTH || ancestors.has(value)) return undefined
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const items = []
      for (const item of value) {
        const kept = project(item, ancestors, depth + 1)
        if (kept !== undefined) items.push(kept)
      }
      return items
    }
    return projectFields(value, ancestors, depth)
  } finally {
    ancestors.delete(value)
  }
}

function projectFields(source, ancestors, depth) {
  const data = {}
  for (const key of Object.keys(source)) {
    // The facts become typed fields below. Keeping the raw envelope too would leave two statements
    // of the same truth inside one object, free to disagree.
    if (key === OUTCOME_KEY) continue
    // Reading a property may itself throw (a hostile getter); an unreadable value is a dropped key.
    let raw
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
 * The tool's own details, JSON-clean, plus the identity of the call. A details value that is not a
 * named object has nothing a consumer could address by name, so only the identity survives.
 */
function dataOf(details, tool, callId) {
  const bag = record(details)
  const data = bag === undefined ? {} : projectFields(bag, new Set([bag]), 0)
  data.tool = tool
  if (typeof callId === 'string' && callId.length > 0) data.callId = callId
  return data
}

/** An unrecognised effect state is not a mild one: effects we cannot name are effects we cannot bound. */
function effectStateOf(value) {
  return typeof value === 'string' && EFFECT_STATES.has(value) ? value : 'unknown'
}

/**
 * Rebuilds coverage from fields we understand. A fact may carry counts we cannot read; those read as
 * zero, and an `isComplete` that is not literally `true` is not a completeness claim.
 */
function coverageOf(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const truncatedBy = typeof raw.truncatedBy === 'string' ? TRUNCATIONS.get(raw.truncatedBy) : undefined
  const coverage = {
    scannedFiles: count(raw.scannedFiles),
    matchedCount: count(raw.matchedCount),
    isComplete: raw.isComplete === true,
  }
  if (truncatedBy !== undefined) coverage.truncatedBy = truncatedBy
  return coverage
}

/** Mirrors `readOutcome`: any missing or wrongly-typed field makes the whole thing unrecognised. */
function readFacts(details) {
  if (typeof details !== 'object' || details === null) return undefined
  const raw = details[OUTCOME_KEY]
  if (typeof raw !== 'object' || raw === null) return undefined
  if (typeof raw.status !== 'string' || typeof raw.effectState !== 'string') return undefined
  if (typeof raw.retry !== 'string' || typeof raw.message !== 'string') return undefined
  return raw
}

/**
 * A failure is never hand-shaped: `errorPolicy` owns the pair `(status, retry)`. A published retry
 * is honoured only when it is one of the four legal advices — the kernel allows exactly one
 * producer-side override (a non-zero shell exit), and recomputing from the code alone would discard
 * it. Anything else is not advice, so the policy answers.
 */
function failure(data, code, message, effectState, nextAction, publishedRetry) {
  const policy = errorPolicy(code, effectState)
  const retry = typeof publishedRetry === 'string' && RETRY_POLICIES.has(publishedRetry)
    ? publishedRetry
    : policy.retry
  const error = { code, effectState, retry, message }
  if (nextAction !== undefined) error.nextAction = nextAction
  return { status: policy.status, error, data }
}

/**
 * The typed projection of one tool result. The order of the three cases is the contract, exactly as
 * in `toOutcome`: published facts first, then an unclassified failure, then a clean observation.
 */
function outcomeOf(tool, details, isError, callId) {
  const data = dataOf(details, tool, callId)
  const facts = readFacts(details)

  if (facts !== undefined) {
    const coverage = coverageOf(facts.coverage)
    const nextAction = typeof facts.nextAction === 'string' && facts.nextAction.length > 0
      ? facts.nextAction
      : undefined
    // `completed` with coverage that is absent or literally complete is a completion claim we can
    // carry. Coverage that says otherwise contradicts the status, and the weaker claim is the true
    // one, so the fact falls through to the incomplete path below.
    if (facts.status === 'completed' && (coverage === undefined || coverage.isComplete)) {
      return coverage === undefined
        ? { status: 'completed', data }
        : { status: 'completed', data, coverage: { ...coverage, isComplete: true } }
    }
    if (facts.status === 'completed' || facts.status === 'partial') {
      // `partial` needs recordable coverage and a continuation. No tool has one today — the
      // TypeScript `continuationFor` answers `undefined`, and inventing a cursor here would turn
      // "we stopped early" into "here is the rest" — so an incomplete observation is refused with
      // the same code and message rather than paged.
      return failure(data, 'RESULT_PARTIAL', NO_CONTINUATION_MESSAGE, effectStateOf(facts.effectState), nextAction, facts.retry)
    }
    return failure(
      data,
      typeof facts.code === 'string' && facts.code.length > 0 ? facts.code : 'RESULT_UNKNOWN',
      facts.message,
      effectStateOf(facts.effectState),
      nextAction,
      facts.retry,
    )
  }

  if (isError) {
    // No rule classified this failure, which is exactly the case where no one has proven what it
    // touched. The only honest advice for an unbounded effect is `never`, so the code and the
    // effect state are both unknown and `errorPolicy` answers `unknown`/`never`.
    return failure(data, 'RESULT_UNKNOWN', UNCLASSIFIED_MESSAGE, 'unknown')
  }

  // Success without coverage accounting is not a claim of completeness, so there is no `coverage`
  // key: absence of evidence must not read as evidence of a full scan.
  return { status: 'completed', data }
}

/**
 * Normalises whatever `awaitTool` resolved with. A result that is not a plain object carries no
 * observation at all — not a details bag, not even an error flag — so it is reported as a failure
 * whose effects cannot be proven instead of being thrown at the script that awaited it.
 */
function normalise(tool, raw) {
  const payload = record(raw)
  if (payload === undefined) return failure({ tool }, 'RESULT_UNKNOWN', UNCLASSIFIED_MESSAGE, 'unknown')
  const callId = typeof payload.toolCallId === 'string' && payload.toolCallId.length > 0 ? payload.toolCallId : undefined
  // The host sends a boolean. Any other truthy value is still a claim that the call failed, and
  // reading it as success is the one direction that loses information.
  return outcomeOf(tool, payload.details, Boolean(payload.isError), callId)
}

/**
 * Builds `ops` over one await function, normally omp's own `tool.<name>`. `awaitTool` is called as
 * `(name, args)` with the caller's args verbatim (an omitted `args` becomes `{}`), and every method
 * answers with the typed projection, never prose. The tool name is the one we invoked: a name
 * echoed in the payload is a copy that could disagree, and ours is the call that actually ran.
 */
function createOps(awaitTool) {
  if (typeof awaitTool !== 'function') {
    throw new TypeError('createOps(awaitTool) requires a function: (name, args) => Promise<raw tool result>')
  }
  const ops = {}
  for (const tool of OPS_TOOLS) {
    ops[tool] = async (args) => normalise(tool, await awaitTool(tool, args ?? {}))
  }
  return Object.freeze(ops)
}

// The load contract, not a side effect for its own sake: `%load` rejects `export`, so a top-level
// declaration would otherwise exist only inside the loaded chunk and never reach the kernel. Node's
// side-effect import of this file takes the same path, which is what lets the parity test read the
// same name the kernel does.
globalThis.createOps = createOps
