import { observe, type ToolObservation } from '../host/contracts.ts'
import {
  attachTransforms,
  registeredTransforms,
  runTransforms,
  type FeatureFlag,
  type MutableResult,
  type TransformContext,
} from '../pipeline.ts'
// Registration side effects: `rules/index.ts` registers every rule transform, `render/index.ts`
// registers the outcome renderer that runs after them, and the dedup barrel hands the coordinator
// its targets when that slice lands. Import order is run order.
import '../rules/index.ts'
import '../render/index.ts'
import '../dedup/index.ts'

/**
 * The slice of the omp extension API this factory uses. The host passes the API object itself as the
 * factory's only argument; its `pi` field is the pi-coding-agent module namespace, not the API.
 */
export interface ExtensionApi {
  on(event: string, handler: (payload: unknown) => unknown): void
}

/**
 * Round 0a factory: one `tool_result` handler and nothing else. 0b owns wiring the payload, so the
 * handler returns `undefined` whenever nothing changed and a wrong guess about the host's return
 * shape cannot alter a tool result.
 */
export default function ompOps(pi: ExtensionApi): void {
  pi.on('tool_result', handleToolResult)
  attachTransforms(pi)
}

function handleToolResult(payload: unknown, ctx?: TransformContext): unknown {
  const o = observe(payload)
  if (o === undefined) return undefined
  const out: MutableResult = { content: [...o.content], details: o.details, isError: o.isError }
  runTransforms(o, out, enabledFeatures(), ctx)
  return changed(o, out) ? { content: out.content, details: out.details, isError: out.isError } : undefined
}

/**
 * Union of the features the registered transforms declare. A stub contributes `honesty` but does
 * nothing, so the flag set is inert until a slice registers a transform that acts on it.
 */
function enabledFeatures(): readonly FeatureFlag[] {
  const flags = new Set<FeatureFlag>()
  for (const t of registeredTransforms()) {
    for (const feature of t.features) flags.add(feature)
  }
  return [...flags]
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
