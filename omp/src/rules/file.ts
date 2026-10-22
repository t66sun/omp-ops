import {
  isMutableDetails,
  OUTCOME_KEY,
  readOutcome,
  type OutcomeFacts,
  type ToolObservation,
} from '../host/contracts.ts'
import { errorPolicy } from '../kernel/errors.ts'
import type { EffectState } from '../kernel/outcome.ts'
import type { MutableResult, Transform } from '../pipeline.ts'

/**
 * Classifies a failed `read`, `edit` or `write` result into the kernel's outcome vocabulary.
 *
 * The one thing these payloads never state is whether the failure changed the file. That answer is
 * the expensive one: replaying a write that partly landed corrupts a file, and retrying an edit with
 * a stale tag can never succeed. omp's failure messages are the only evidence a rule gets — every
 * observed file-tool failure arrives with `isError: true` and no `details` at all — so the messages
 * are read as a grammar, and only the shapes that provably fail before touching the file are called
 * `effectState: 'none'`. Anything narrower is left at `unknown`/`RESULT_UNKNOWN`, which
 * `errorPolicy` turns into `retry: 'never'`; effects dominate retry advice, never the reverse.
 *
 * A `read` is the exception: it cannot write, so every read failure is `none` regardless of text.
 */

interface Failure {
  readonly code: string
  readonly effectState: EffectState
  readonly message: string
}

/** The tools this rule has an opinion about; `apply_patch`/`patch` were never observed. */
const FILE_TOOLS: readonly string[] = ['read', 'edit', 'write']

/**
 * A rejection the host raises before its first write. `Edit rejected for <path>:` prefixes every
 * hashline validation failure (foreign tag, absent tag, out-of-range lines, no-op section).
 */
const EDIT_REJECTED = /^Edit rejected for /
/** The seen-line refusal: the anchor points at lines the session was never shown. */
const EDIT_UNSEEN = /never displayed/
/** A hash or tag the session does not own. */
const EDIT_STALE_TAG = /is not from this session|has changed since that tag/
/** A missing tag on an otherwise anchored header. */
const EDIT_MISSING_TAG = /needs this file's current tag/
/** Replace-mode search miss: the edit never reached the file. */
const EDIT_NO_MATCH = /^Could not find a close enough match/
/** The host decoded the file first and refused to edit bytes it cannot represent as text. */
const EDIT_ENCODING = /is not valid UTF-8/
/** Both tools say the same thing when the path does not exist. */
const NOT_FOUND = /^(?:File not found: |Path '.*' not found)/

/**
 * A syscall failure is only proof of "nothing written" when the failing operation is the `open`:
 * a refused open truncates nothing, while a failed `write`/`rename`/`fsync` may already have
 * landed half a file. The operation name is therefore part of the pattern, not decoration.
 */
const WRITE_OPEN_FAILED = /^(EISDIR|EPERM|EACCES): [^,]*, open '/

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function textOf(content: readonly unknown[]): string {
  const parts: string[] = []
  for (const part of content) {
    const text = asRecord(part)?.['text']
    if (typeof text === 'string') parts.push(text)
  }
  return parts.join('')
}

/** The path the call named, for the message only; classification never depends on it. */
function targetOf(o: ToolObservation): string | undefined {
  const args = asRecord(o.args)
  if (args === undefined) return undefined
  const path = args['path']
  if (typeof path === 'string' && path.length > 0) return path
  const paths = args['paths']
  if (Array.isArray(paths)) {
    for (const entry of paths) if (typeof entry === 'string' && entry.length > 0) return entry
  }
  return undefined
}

/** A read never writes, so the failure text only decides *which* honest code to report. */
function readFailure(text: string, target: string | undefined): Failure {
  const name = target ?? 'the target'
  if (NOT_FOUND.test(text)) {
    return {
      code: 'NOT_FOUND',
      effectState: 'none',
      message: `read did not find ${name}: nothing was read and nothing was written on disk. Check the path (a relative path resolves against the working directory) before retrying.`,
    }
  }
  return {
    code: 'IO_ERROR',
    effectState: 'none',
    message: `read of ${name} failed; a read never writes, so nothing on disk changed. Retrying the same path only helps once the file exists or its permissions change.`,
  }
}

function editFailure(text: string, target: string | undefined): Failure {
  const name = target ?? 'the target'
  if (NOT_FOUND.test(text)) {
    return {
      code: 'NOT_FOUND',
      effectState: 'none',
      message: `edit did not find ${name}: nothing was written. Create the file with write, or correct the path.`,
    }
  }
  if (EDIT_ENCODING.test(text)) {
    return {
      code: 'ERR_INVALID_ENCODING',
      effectState: 'none',
      message: `edit refused ${name}: the file is not valid UTF-8, so no text anchor can apply; nothing was written. Editing it as text cannot succeed until the bytes are decoded or replaced.`,
    }
  }
  if (EDIT_UNSEEN.test(text)) {
    return {
      code: 'EDIT_CONFLICT',
      effectState: 'none',
      message: `edit of ${name} anchored to lines this session never displayed, so the host rejected it before writing; nothing on disk changed. Read those lines, then re-issue the edit.`,
    }
  }
  if (EDIT_REJECTED.test(text)) {
    const stale = EDIT_STALE_TAG.test(text) || EDIT_MISSING_TAG.test(text)
    return {
      code: 'EDIT_CONFLICT',
      effectState: 'none',
      message: stale
        ? `edit of ${name} was rejected before writing because its [path#tag] header is not the file's current one; nothing on disk changed. Use the tag from a fresh read, then re-issue the edit.`
        : `edit of ${name} was rejected before the first write, so nothing on disk changed. Apply the rejection's correction, then re-issue the edit.`,
    }
  }
  if (EDIT_NO_MATCH.test(text)) {
    return {
      code: 'EDIT_CONFLICT',
      effectState: 'none',
      message: `edit found no match in ${name}; the file was not modified. Re-read it and target its current text.`,
    }
  }
  return {
    code: 'RESULT_UNKNOWN',
    effectState: 'unknown',
    message: `edit of ${name} failed without saying whether any section landed; treat the file as possibly modified. Re-read it before editing again.`,
  }
}

function writeFailure(text: string, target: string | undefined): Failure {
  const name = target ?? 'the target'
  const open = WRITE_OPEN_FAILED.exec(text)
  if (open !== null) {
    if (open[1] === 'EISDIR') {
      return {
        code: 'IS_DIRECTORY',
        effectState: 'none',
        message: `write refused ${name}: the path is a directory, and the failing open wrote nothing. Pick a file path inside it.`,
      }
    }
    return {
      code: 'PATH_RESTRICTED',
      effectState: 'none',
      message: `write refused ${name}: the host was denied permission at open, so the file was not touched. Fix the permissions or the read-only attribute before retrying.`,
    }
  }
  return {
    code: 'RESULT_UNKNOWN',
    effectState: 'unknown',
    message: `write to ${name} failed without saying whether the file was created or truncated; treat it as possibly modified. Re-read it before writing again.`,
  }
}

function classify(o: ToolObservation): Failure | undefined {
  if (!o.isError) return undefined
  if (!FILE_TOOLS.includes(o.tool)) return undefined
  const text = textOf(o.content)
  const target = targetOf(o)
  if (o.tool === 'read') return readFailure(text, target)
  if (o.tool === 'edit') return editFailure(text, target)
  return writeFailure(text, target)
}

function factsOf(failure: Failure): OutcomeFacts {
  const policy = errorPolicy(failure.code, failure.effectState)
  return {
    status: policy.status,
    effectState: failure.effectState,
    retry: policy.retry,
    code: failure.code,
    message: failure.message,
  }
}

/**
 * Writes the facts where a later reader can find them. Every observed file-tool failure arrives with
 * no `details` at all, so for those shapes this rule installs the container it needs; when the host
 * supplied details that cannot be edited (frozen, a primitive) the result is left alone.
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
  name: 'rules/file',
  features: ['honesty'],
  apply(o, out) {
    const failure = classify(o)
    if (failure === undefined) return
    publish(out, factsOf(failure))
  },
}
