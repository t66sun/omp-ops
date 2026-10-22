/**
 * Where an incomplete observation may be continued from: the token the frozen `Outcome` type
 * stores, and the one encoder that produces it.
 *
 * A token is data, never authority: it names a read-only retrieval, so it can never authorise
 * replaying an operation. It is built only when the observation itself proves where the next page
 * starts — a cursor in `details`, not a count in the coverage facts — because "we stopped early" is
 * not the same claim as "here is the rest". Every other shape answers `undefined`.
 */
import type { OutcomeFacts, ToolObservation } from '../host/contracts.ts'
import { record, type CanonicalData } from './types.ts'

/** The prefix is versioned so a token from a different contract is refused, not guessed at. */
export const PREFIX = 'ops-next-v1:'
/** Past this size a "continuation" is a request no caller should have to paste; it is refused. */
export const MAX_TOKEN_BYTES = 8192

/**
 * An offset is a whole count. `'24'`, `1.5`, `NaN` and a missing field are not approximations of a
 * position but unreadable data, and a page starting at a guessed offset is a wrong page.
 */
function offset(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

/**
 * One selector segment: a line, an open line range, a range, a count, or a comma list of those.
 * The open range `24-` is included because it is the spelling this module itself emits, so the next
 * page of the same read is recognised and rewritten instead of nested (`:24-:48-`).
 */
const SEGMENT = String.raw`\d+(?:-\d*|\+\d*)?`
const SELECTOR = new RegExp(`^(?:raw|img|conflicts|${SEGMENT}(?:,${SEGMENT})*)$`)

/** The exact shape this module emits: a trailing open range. */
const OPEN_RANGE = /:(\d+)-$/

/**
 * True when the path already carries a selector, i.e. a trailing `:` and a selector body. A drive
 * letter is not a selector: `C:\x` and `C:/x` have a colon followed by a separator, which no
 * selector segment matches.
 */
function hasSelector(path: string): boolean {
  const colon = path.lastIndexOf(':')
  return colon >= 0 && SELECTOR.test(path.slice(colon + 1))
}

/**
 * `read` continuation: the withheld body is a line range, and `nextOffset` is the one trustworthy
 * number in the paging record — `totalBytes` has been observed to report 1577 for a ~61 KB file, so
 * it is never consulted. A `tail` truncation withholds the end of the file, which appending a range
 * cannot recover.
 */
function readContinuation(details: CanonicalData, args: CanonicalData): string | undefined {
  const meta = record(details.meta)
  const truncation = meta === undefined ? undefined : record(meta.truncation)
  if (truncation === undefined || truncation.direction !== 'head') return undefined
  const next = offset(truncation.nextOffset)
  // Offset 1 is the first line, which the caller already has; it proves no progress.
  if (next === undefined || next < 2) return undefined
  const path = args.path
  if (typeof path !== 'string' || path.length === 0) return undefined
  // `nextOffset` is absolute: reading `big.txt:24-` in a 900-line file reports `shownRange 23-323`
  // and `nextOffset 324`, so the next page is the same request with its start replaced. Rewriting
  // rather than appending is what lets a long file chain past one page, while never producing the
  // nonsense `:24-:48-`.
  if (OPEN_RANGE.test(path)) return encode('read', { path: path.replace(OPEN_RANGE, `:${next}-`) })
  if (hasSelector(path)) return undefined
  return encode('read', { path: `${path}:${next}-` })
}

/**
 * `grep` continuation: only a file-page limit is continuable, because the scan then stopped between
 * files and `skip` (a file-page offset) names where it stopped. A per-file match cap and a column
 * cut are not continuable: re-issuing the same page returns the same rows, so a token would be a
 * promise the tool cannot keep.
 */
function grepContinuation(details: CanonicalData, args: CanonicalData): string | undefined {
  const limit = offset(details.fileLimitReached)
  if (limit === undefined || limit <= 0) return undefined
  const files = offset(details.fileCount)
  if (files === undefined || files <= 0) return undefined
  return encode('grep', { ...args, skip: (Number(args.skip) || 0) + files })
}

/**
 * The token for the next page of this observation, or `undefined` when the observation does not
 * prove one. `facts.coverage.isComplete === true` means nothing was withheld, so it outranks any
 * cursor-like field: a complete scan with a stray `nextOffset` is still a complete scan.
 */
export function continuationFor(o: ToolObservation, facts: OutcomeFacts): string | undefined {
  if (facts.coverage?.isComplete === true) return undefined
  const details = record(o.details)
  const args = record(o.args)
  if (details === undefined || args === undefined) return undefined
  switch (o.tool) {
    case 'read': return readContinuation(details, args)
    case 'grep': return grepContinuation(details, args)
    // `glob` scan budgets, shell output, edits and writes publish no cursor: their remainder is not
    // addressable by re-issuing a page, so there is nothing honest to encode.
    default: return undefined
  }
}

/**
 * The only encoder. Values JSON cannot spell (a bigint, a cycle inside the caller's args) have no
 * token rather than a lossy one, and a token over the byte cap is refused so that `decodeContinuation`
 * and the producer agree on exactly one boundary.
 */
export function encode(tool: string, args: CanonicalData): string | undefined {
  let body: string
  try {
    body = JSON.stringify({ version: 1, tool, args })
  } catch {
    return undefined
  }
  const token = PREFIX + body
  return Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES ? undefined : token
}

/**
 * The positional form, kept because callers that hold only a tool name and its arguments still ask.
 * It builds an observation without `details`, and a cursor lives in `details`, so it can never prove
 * a page and always answers `undefined`: a caller holding an observation must use `continuationFor`.
 */
export function continuationForTool(tool: string, args: unknown, facts: OutcomeFacts): string | undefined {
  return continuationFor({ tool, args, content: [], details: undefined, isError: false }, facts)
}
