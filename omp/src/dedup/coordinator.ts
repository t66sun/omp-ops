/** STUB — replaced by slice dedup/coordinator */
import type { Transform } from '../pipeline.ts'

export function createDedup(): Transform {
  return { name: 'dedup/read', features: ['dedup'], apply() {} }
}
