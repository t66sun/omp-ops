/**
 * PTC barrel. Importing this module is the one place the SDK's surface is decided, so a slice edits
 * only its own file: the projection lives in `outcome.ts`, the vocabulary in `types.ts`, and the
 * three sibling slices contribute installed bindings, not new names here.
 *
 * Unlike `../dedup/index.ts` there is nothing to register at import time: PTC is code-facing, and
 * its wiring is `installPrelude`, which needs the host and therefore runs when the extension loads.
 */
export { toOutcome, continuationFor, decodeContinuation } from './outcome.ts'
export { record, count } from './types.ts'
export type { JsonValue, CanonicalData, Invoke, Ops, OpsTool } from './types.ts'

export * from './continuation.ts'
export * from './js/ops.ts'
export * from './prelude.ts'
