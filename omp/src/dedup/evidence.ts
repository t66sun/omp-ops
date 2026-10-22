import { lstatSync } from 'node:fs'
import type { FileIdentity, ReadRecord } from './types.ts'

/**
 * Filesystem half of the dedup proof: what file did we read, and is it still that file?
 *
 * `lstat` (not `stat`) is deliberate: a symlink must be judged as itself so that retargeting the
 * link invalidates the record, even when the final bytes are unchanged. A regular file with
 * `ino === 0n` cannot be proven either — the platform reports no usable identity, so we fail
 * closed and let the caller send the verbatim body.
 *
 * Never throws: a vanished path, `EACCES`, or a symlink loop is simply "no proof".
 */
export function identityOf(path: string, expectedSize: bigint): FileIdentity | undefined {
  try {
    const stat = lstatSync(path, { bigint: true })
    if (stat.isSymbolicLink() || !stat.isFile()) return undefined
    if (stat.ino === 0n) return undefined
    if (stat.size !== expectedSize) return undefined
    return {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
    }
  } catch {
    return undefined
  }
}

const IDENTITY_FIELDS = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const

/** Field-by-field, bigint-strict. A missing field on either side is a mismatch, never a match. */
function sameIdentity(recorded: FileIdentity, current: FileIdentity): boolean {
  for (const field of IDENTITY_FIELDS) {
    const left = recorded[field]
    const right = current[field]
    if (typeof left !== 'bigint' || typeof right !== 'bigint') return false
    if (left !== right) return false
  }
  return true
}

/**
 * Presence half of the dedup proof: is the body we want to collapse still in the model's context,
 * and is the file on disk still the file whose bytes that context holds?
 *
 * Design note — DSH proved presence by re-scanning the message history for a byte-identical
 * `role: 'tool'` message with the matching `id`/`toolCallId`. omp's `tool_result` handler cannot
 * read that history, so the port proves it with an epoch that the coordinator bumps on every
 * `session_before_compact` / `session_compact` and on every context rewrite: presence-within-epoch
 * plus an unchanged inode is the substitute proof, which is weaker than a byte-identical history
 * match (a host rewrite we never observe is caught only by the compaction events) but does not
 * depend on host internals that drift between omp versions.
 *
 * Never throws, and any single mismatch refuses the rewrite — the caller then sends the full body.
 */
export function proveRecord(
  record: ReadRecord,
  current: { agentKey: string; epoch: number; identity: FileIdentity },
): boolean {
  try {
    if (record.agentKey !== current.agentKey) return false
    if (record.epoch !== current.epoch) return false
    return sameIdentity(record.identity, current.identity)
  } catch {
    return false
  }
}
