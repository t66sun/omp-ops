import type { ToolObservation } from './contracts.ts'

/**
 * Payload readers for the Round 1 rule slices. Every function here answers one question about a
 * `tool_result` and returns `undefined` for shapes it does not recognise, so a caller can treat
 * "not my shape" and "no opinion" the same way: leave the result untouched.
 *
 * The shapes below are copied from omp 18.12.6 sessions, not from documentation; the captured
 * payloads and the one-line proof for each live in `docs/porting/spike-report.md`.
 *
 * Each reader is gated on the tool name as well as the payload: the details grammars overlap
 * (`write` returns `resolvedPath`, `glob` returns `fileCount`), so the name is what keeps a
 * `write` result from being read as a successful `read`.
 */

export interface BashFacts {
  /** `details.exitCode`; absent on success, on a background hand-off and on timeout. */
  exitCode: number | undefined
  timedOut: boolean
  /** The call was cancelled before it finished (host `[Command aborted]` / `[Command cancelled]`). */
  aborted: boolean
  /** The host refused before execution: an approval gate, not a failing command. */
  denied: boolean
}

export interface ReadFacts {
  /** One entry per file actually read, in the order the host reported them. */
  paths: readonly string[]
  truncated: boolean
}

export interface GrepFacts {
  matchCount: number
  fileCount: number
  truncated: boolean
  /** The file count limit cut the result (host reports the limit value, so presence is the flag). */
  fileLimitReached: boolean
  /** At least one file hit the per-file match cap (same presence-means-reached convention). */
  perFileLimitReached: boolean
  /** Individual matching lines were cut to the column limit. */
  linesTruncated: boolean
  /** How many requested paths did not exist; `0` when the host reported no `missingPaths`. */
  missingPaths: number
}

/** Keys the bash tool always writes to `details`, and no other tool does. */
const BASH_KEYS: readonly string[] = ['wallTimeMs', 'wallTimeNoticeEmitted', 'timeoutSeconds', 'timedOut', 'async', 'exitCode']

const DENIED = /requires approval/i
const ABORTED = /Command (?:aborted|cancelled)/i

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function textOf(content: readonly unknown[]): string {
  const parts: string[] = []
  for (const part of content) {
    const record = asRecord(part)
    const text = record?.['text']
    if (typeof text === 'string') parts.push(text)
  }
  return parts.join('')
}

/**
 * A denial and a cancellation reach us without `details`: the host refuses (or unwinds) before the
 * tool produces a payload, so the only evidence is the message. A plain non-zero exit is *not* one
 * of these — it lands in the `details` branch with `exitCode` set.
 */
function failureWithoutDetails(o: ToolObservation): BashFacts | undefined {
  if (!o.isError || o.details !== undefined) return undefined
  const text = textOf(o.content)
  const denied = DENIED.test(text)
  const aborted = !denied && ABORTED.test(text)
  if (!denied && !aborted) return undefined
  return { exitCode: undefined, timedOut: false, aborted, denied }
}

export function bashFacts(o: ToolObservation): BashFacts | undefined {
  if (o.tool !== 'bash') return undefined
  const details = asRecord(o.details)
  if (details === undefined) return failureWithoutDetails(o)
  if (!BASH_KEYS.some((key) => details[key] !== undefined)) return undefined
  const exitCode = details['exitCode']
  return {
    exitCode: typeof exitCode === 'number' ? exitCode : undefined,
    timedOut: details['timedOut'] === true,
    aborted: false,
    denied: false,
  }
}

function stringsFrom(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const entry of value) if (typeof entry === 'string' && entry.length > 0) out.push(entry)
  return out.length === 0 ? undefined : out
}

/** The host writes a truncation record only when it cut output, so presence is the flag. */
function truncationRecord(value: unknown): boolean {
  const record = asRecord(value)
  return record !== undefined && record['truncated'] !== false
}

function readPaths(details: Record<string, unknown>): string[] | undefined {
  const meta = asRecord(details['meta'])
  const source = meta === undefined ? undefined : asRecord(meta['source'])
  const sourcePath = source?.['value']
  if (typeof sourcePath === 'string' && sourcePath.length > 0) return [sourcePath]
  const resolved = details['resolvedPath']
  if (typeof resolved === 'string' && resolved.length > 0) return [resolved]
  // A multi-target read has no single source; the link form is the absolute, range-free path.
  const links = stringsFrom(details['displayReadTargetLinks'])
  if (links !== undefined) return links
  const targets = stringsFrom(details['displayReadTargets'])
  if (targets !== undefined) return targets
  return undefined
}

export function readFacts(o: ToolObservation): ReadFacts | undefined {
  if (o.tool !== 'read') return undefined
  const details = asRecord(o.details)
  if (details === undefined) return undefined
  const paths = readPaths(details)
  if (paths === undefined) return undefined
  const meta = asRecord(details['meta'])
  return {
    paths,
    truncated: truncationRecord(details['truncation']) || truncationRecord(meta?.['truncation']),
  }
}

export function grepFacts(o: ToolObservation): GrepFacts | undefined {
  if (o.tool !== 'grep') return undefined
  const details = asRecord(o.details)
  if (details === undefined) return undefined
  const matchCount = details['matchCount']
  const fileCount = details['fileCount']
  if (typeof matchCount !== 'number' || typeof fileCount !== 'number') return undefined
  const missing = details['missingPaths']
  return {
    matchCount,
    fileCount,
    truncated: details['truncated'] === true,
    fileLimitReached: details['fileLimitReached'] !== undefined,
    perFileLimitReached: details['perFileLimitReached'] !== undefined,
    linesTruncated: details['linesTruncated'] === true,
    missingPaths: Array.isArray(missing) ? missing.length : 0,
  }
}
