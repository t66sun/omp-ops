import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { isMutableDetails, type ToolObservation } from '../../host/contracts.ts'
import { identityOf } from '../evidence.ts'
import type { DedupCandidate, DedupTarget, FileIdentity } from '../types.ts'

/**
 * omp appends this marker when it cuts a body to fit the output budget. Such a body is a prefix of
 * the file, so remembering it under the file's identity would let a later read of the *whole* file
 * be replaced by a reference to a fragment. Never eligible.
 */
const TRUNCATION_MARKER = 'TruncatedBy: output-budget'

/** The body we may dedup is exactly one text block; anything else (images, multiple blocks) is not text. */
function singleText(o: ToolObservation): string | undefined {
  if (o.content.length !== 1) return undefined
  const block = o.content[0]
  if (typeof block !== 'object' || block === null) return undefined
  const { type, text } = block as { type?: unknown; text?: unknown }
  if (type !== 'text' || typeof text !== 'string') return undefined
  return text
}

/** omp reports where the bytes came from in `details.meta.source`; only a path can be re-proved later. */
function sourcePath(details: unknown): string | undefined {
  if (!isMutableDetails(details)) return undefined
  const meta = details.meta
  if (typeof meta !== 'object' || meta === null) return undefined
  const source = (meta as Record<string, unknown>).source
  if (typeof source !== 'object' || source === null) return undefined
  const { type, value } = source as { type?: unknown; value?: unknown }
  if (type !== 'path' || typeof value !== 'string' || !isAbsolute(value)) return undefined
  return value
}

/**
 * Bigints throw inside `JSON.stringify`, so every identity field is stringified explicitly. The
 * result is stable for one (tool, args, file state) triple and changes whenever any of them does.
 */
function stableKey(tool: string, args: unknown, identity: FileIdentity): string | undefined {
  try {
    return JSON.stringify([
      tool,
      args,
      identity.dev.toString(),
      identity.ino.toString(),
      identity.size.toString(),
      identity.mtimeNs.toString(),
      identity.ctimeNs.toString(),
    ])
  } catch {
    return undefined
  }
}

export const readTarget: DedupTarget = {
  name: 'read',
  extract(o) {
    if (o.tool !== 'read' || o.isError) return undefined
    const text = singleText(o)
    if (text === undefined || text.includes(TRUNCATION_MARKER)) return undefined
    const path = sourcePath(o.details)
    if (path === undefined) return undefined

    let size: bigint
    try {
      const stat = statSync(path, { bigint: true })
      if (!stat.isFile()) return undefined
      size = stat.size
    } catch {
      return undefined
    }

    const identity = identityOf(path, size)
    if (identity === undefined) return undefined

    const key = stableKey(o.tool, o.args, identity)
    if (key === undefined) return undefined

    return {
      key,
      body: text,
      identity,
      revision: createHash('sha256').update(text).digest('hex'),
    } satisfies DedupCandidate
  },
}
