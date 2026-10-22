/** STUB — replaced by slice honesty/render */
import type { Transform } from '../pipeline.ts'

/**
 * Runs last so every rule has already published its facts. The real slice turns `details['outcome.v1']`
 * into one model-visible line and must be idempotent: a second pass over the same result appends
 * nothing.
 */
export const transform: Transform = { name: 'honesty/render', features: ['honesty'], apply() {} }
