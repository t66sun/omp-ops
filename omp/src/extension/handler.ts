/**
 * The one place a `tool_result` payload becomes a host-shaped patch.
 *
 * Exists as a factory because omp loads every extension entry in its own module graph: two entries
 * importing this file get two copies of it, and a `tool_result` handler registered by one entry cannot
 * see transforms registered by another. (Measured, not assumed: an entry that imported the honesty
 * barrel registered five transforms and the base entry's handler still saw an empty registry.) So each
 * entry owns one handler and the features it declares, and the registry inside its graph holds exactly
 * the transforms it imported.
 */
import { observe, type ToolObservation } from '../host/contracts.ts'
import { runTransforms, type FeatureFlag, type MutableResult, type TransformContext } from '../pipeline.ts'

export type ToolResultHandler = (payload: unknown, ctx?: TransformContext) => unknown

/**
 * Runs every transform registered in this entry's graph whose features intersect `owned`, and returns a
 * patch only when the result actually changed. `undefined` means "leave the tool result alone", which is
 * the host's documented no-op return.
 */
export function createHandler(owned: readonly FeatureFlag[]): ToolResultHandler {
  return (payload, ctx) => {
    const o = observe(payload)
    if (o === undefined) return undefined
    const out: MutableResult = { content: [...o.content], details: o.details, isError: o.isError }
    runTransforms(o, out, owned, ctx)
    return changed(o, out) ? { content: out.content, details: out.details, isError: out.isError } : undefined
  }
}

/**
 * Only `content` is compared by value, because it is the only field copied: `details` travels by
 * reference, so a transform that edited it in place has already reached the host.
 */
function changed(o: ToolObservation, out: MutableResult): boolean {
  if (out.isError !== o.isError) return true
  if (out.details !== o.details) return true
  if (out.content.length !== o.content.length) return true
  return out.content.some((item, i) => item !== o.content[i])
}
