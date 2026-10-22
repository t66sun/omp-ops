/** STUB — replaced by slice dedup/store */
import type { DedupStore } from './types.ts'

export function createStore(): DedupStore {
  return { remember() {}, lookup: () => undefined, forget() {}, size: () => 0, bytes: () => 0, dispose() {} }
}
