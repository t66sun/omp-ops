/**
 * PTC's data vocabulary. Everything code hands to `ops.*` and receives back is JSON, so these are
 * the only types that can cross that boundary without inventing a second serialisation contract.
 */
import type { Outcome } from '../kernel/outcome.ts'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** A named bag of JSON. PTC never returns a bare primitive: `Outcome<CanonicalData>` is the shape. */
export type CanonicalData = { [key: string]: JsonValue }

/**
 * A plain object — not `null`, not an array — i.e. the only thing PTC treats as having named
 * fields. A fact that is not reachable this way is not partially understood; it is absent.
 */
export function record(value: unknown): CanonicalData | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as CanonicalData) : undefined
}

/**
 * A count is a non-negative safe integer. `NaN`, `-1`, `1.5`, `'7'` and a missing field are not
 * approximations of a count but unreadable data, and unreadable data reads as zero.
 */
export function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/** The one call site the SDK is handed: run a tool by name, resolve with whatever the host produced. */
export type Invoke = (tool: string, args: CanonicalData) => Promise<unknown>

/**
 * The omp tool surface PTC exposes as `ops.<name>`. The names are the host's, not ours: a new tool
 * is added here once and every consumer of `Ops` follows.
 */
export type OpsTool = 'read' | 'write' | 'edit' | 'glob' | 'grep' | 'bash' | 'eval' | 'task'

/** One method per tool. Every one of them answers with the typed projection, never prose. */
export type Ops = { readonly [K in OpsTool]: (args: CanonicalData) => Promise<Outcome<CanonicalData>> }
