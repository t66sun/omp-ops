import { createHash } from 'node:crypto'
import type { ToolObservation } from '../../host/contracts.ts'
import type { DedupCandidate, DedupTarget, FileIdentity } from '../types.ts'

/**
 * A grep result spans many files, so there is no single file inode whose identity could prove the
 * body is still valid. The all-zero identity is a deliberate "no file backs this record": a grep
 * result is keyed by its own bytes (the `revision` digest of the exact text) instead, and any change
 * to that text changes the key, so a stale record can never be matched by accident.
 */
const NO_FILE_IDENTITY: FileIdentity = {
  dev: 0n,
  ino: 0n,
  size: 0n,
  mtimeNs: 0n,
  ctimeNs: 0n,
}

/** Any one of these being truthy means the model saw a partial page, not the whole result. */
const PARTIAL_FLAGS = ['truncated', 'fileLimitReached', 'perFileLimitReached', 'linesTruncated'] as const

/** The two sentinels grep uses when the text carries no matches and therefore proves nothing. */
const NO_MATCHES = 'No matches found'
const NO_MORE_RESULTS = 'No more results'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstText(content: readonly unknown[]): string | undefined {
  if (content.length !== 1) return undefined
  const block = content[0]
  if (!isRecord(block)) return undefined
  if (block.type !== 'text' || typeof block.text !== 'string') return undefined
  return block.text
}

/**
 * A result is a paged continuation when it carries a positive cursor. A `skip` of any other type is
 * not a cursor we understand, so it also disqualifies: we cannot prove the page is the first one.
 */
function isPagedContinuation(args: unknown): boolean {
  if (!isRecord(args) || !('skip' in args)) return false
  const skip = args.skip
  return typeof skip !== 'number' || skip > 0
}

function extract(o: ToolObservation): DedupCandidate | undefined {
  if (o.tool !== 'grep' || o.isError !== false) return undefined
  const body = firstText(o.content)
  if (body === undefined) return undefined
  if (body === NO_MATCHES || body.startsWith(NO_MORE_RESULTS)) return undefined
  if (!isRecord(o.details)) return undefined
  const details = o.details
  const { matchCount, fileCount } = details
  if (typeof matchCount !== 'number' || typeof fileCount !== 'number') return undefined
  if (fileCount <= 0) return undefined
  if (PARTIAL_FLAGS.some((flag) => Boolean(details[flag]))) return undefined
  if (isPagedContinuation(o.args)) return undefined
  const revision = createHash('sha256').update(body).digest('hex')
  return {
    key: JSON.stringify(['grep', o.args, revision]),
    body,
    identity: NO_FILE_IDENTITY,
    revision,
  }
}

export const grepTarget: DedupTarget = { name: 'grep', extract }
