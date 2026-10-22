import type { DedupStore, ReadRecord } from './types.ts'

/** Hard caps, mirroring `src/modes/native/read-dedup.ts`. A long session can hit all three. */
export const MAX_AGENTS = 16
export const MAX_RECORDS = 32
export const MAX_BODY_BYTES = 2 * 1024 * 1024

interface Bucket {
  readonly records: Map<string, ReadRecord>
  bytes: number
}

/**
 * One bucket per agent, oldest bucket first (Map insertion order = first-seen order). Records
 * inside a bucket are also oldest first; `Map.set` of an existing key keeps its slot, so a
 * replacement deletes then re-inserts to become most-recent.
 */
export function createStore(): DedupStore {
  const agents = new Map<string, Bucket>()
  let records = 0
  let bodyBytes = 0

  const drop = (bucket: Bucket, key: string): void => {
    const record = bucket.records.get(key)
    if (!record) return
    bucket.records.delete(key)
    bucket.bytes -= record.bytes
    bodyBytes -= record.bytes
    records -= 1
  }

  const dropAgent = (agentKey: string): void => {
    const bucket = agents.get(agentKey)
    if (!bucket) return
    agents.delete(agentKey)
    bodyBytes -= bucket.bytes
    records -= bucket.records.size
  }

  /** Oldest record across all agents: first record of the first agent that still holds one. */
  const evictOldest = (): boolean => {
    for (const [agentKey, bucket] of agents) {
      const oldest = bucket.records.keys().next()
      if (oldest.done) continue
      drop(bucket, oldest.value)
      if (bucket.records.size === 0) agents.delete(agentKey)
      return true
    }
    return false
  }

  return {
    remember(record: ReadRecord): void {
      const size = record.bytes
      // A body that cannot fit the whole budget is refused outright, never used to flush the store.
      if (!(size >= 0) || size > MAX_BODY_BYTES) return
      let bucket = agents.get(record.agentKey)
      const previous = bucket?.records.get(record.key)
      // A same-key refresh frees its old copy first, so it needs no eviction to fit again.
      if (bucket && previous) drop(bucket, record.key)
      while (bodyBytes + size > MAX_BODY_BYTES && evictOldest()) {}
      bucket = agents.get(record.agentKey)
      if (!bucket) {
        if (agents.size >= MAX_AGENTS) {
          const oldest = agents.keys().next()
          if (!oldest.done) dropAgent(oldest.value)
        }
        bucket = { records: new Map(), bytes: 0 }
        agents.set(record.agentKey, bucket)
      }
      bucket.records.set(record.key, record)
      bucket.bytes += size
      bodyBytes += size
      records += 1
      while (bucket.records.size > MAX_RECORDS) {
        const oldest = bucket.records.keys().next()
        if (oldest.done) break
        drop(bucket, oldest.value)
      }
    },

    lookup(agentKey: string, epoch: number, key: string): ReadRecord | undefined {
      const record = agents.get(agentKey)?.records.get(key)
      // An epoch mismatch is a miss: nothing read before the last mutation may be referenced.
      return record && record.epoch === epoch ? record : undefined
    },

    forget(agentKey: string): void {
      dropAgent(agentKey)
    },

    size: () => records,
    bytes: () => bodyBytes,

    dispose(): void {
      agents.clear()
      records = 0
      bodyBytes = 0
    },
  }
}
