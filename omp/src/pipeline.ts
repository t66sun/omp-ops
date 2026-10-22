import type { ToolObservation } from './host/contracts.ts'

export type FeatureFlag = 'honesty' | 'dedup' | 'ptc'

export interface MutableResult {
  content: unknown[]
  details: unknown
  isError: boolean
}

/**
 * Whatever the host hands a `tool_result` handler as its second argument. Deliberately untyped: the
 * host may extend it, and a slice that needs a field must narrow it at the point of use rather than
 * have the contract promise something it cannot verify.
 */
export type TransformContext = Record<string, unknown>

export interface Transform {
  readonly name: string
  readonly features: readonly FeatureFlag[]
  /** MUST be total: never throw, never grow `content`/`details`, never flip `isError`. */
  apply(o: ToolObservation, out: MutableResult, ctx?: TransformContext): void
  /**
   * Called once with the extension API when the extension loads, for transforms that must observe
   * session events (compaction, context rewrites) rather than a single tool result. Optional.
   */
  attach?(host: unknown): void
}

const registry: Transform[] = []
const failed: string[] = []

/**
 * Rejects a duplicate name by throwing: two transforms sharing an identity make the edit history of
 * `content` unattributable, and that is a programming error loud enough to stop the extension load.
 */
export function registerTransform(t: Transform): void {
  for (const existing of registry) {
    if (existing.name === t.name) throw new Error(`duplicate transform: ${t.name}`)
  }
  registry.push(t)
}

export function registeredTransforms(): readonly Transform[] {
  return registry
}

/**
 * Runs the registered transforms in registration order, skipping any whose features miss `enabled`.
 * A throwing transform is swallowed and recorded: a broken slice must never break a tool result.
 */
export function runTransforms(
  o: ToolObservation,
  out: MutableResult,
  enabled: readonly FeatureFlag[],
  ctx?: TransformContext,
): void {
  for (const t of registry) {
    if (!t.features.some((feature) => enabled.includes(feature))) continue
    try {
      t.apply(o, out, ctx)
    } catch {
      if (!failed.includes(t.name)) failed.push(t.name)
    }
  }
}

/** Calls every registered transform's `attach` once. A throwing `attach` is recorded, not fatal. */
export function attachTransforms(host: unknown): void {
  for (const t of registry) {
    if (t.attach === undefined) continue
    try {
      t.attach(host)
    } catch {
      if (!failed.includes(t.name)) failed.push(t.name)
    }
  }
}

/** Transform names that threw, deduped and in first-failure order. */
export function transformFailures(): readonly string[] {
  return [...failed]
}
