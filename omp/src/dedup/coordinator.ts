import type { ToolObservation } from '../host/contracts.ts'
import type { MutableResult, Transform, TransformContext } from '../pipeline.ts'
import { proveRecord } from './evidence.ts'
import { rewriteBody } from './rewrite.ts'
import { createStore } from './store.ts'
import { grepTarget } from './targets/grep.ts'
import { readTarget } from './targets/read.ts'
import type { DedupCandidate, DedupTarget } from './types.ts'

/**
 * Tools whose success may have changed bytes on disk. Any of them invalidates every body recorded
 * for that agent: a body read before the mutation is no longer known to be the file's content, and
 * pointing the model at it would describe a file that no longer exists. The check is on the tool,
 * not on the details, because a mutating tool that reports success has necessarily had its effect.
 */
const MUTATING: Record<string, true> = { edit: true, write: true, bash: true }

/**
 * Every event after which the model's context is no longer the context we remembered bodies in.
 * A compaction replaces the history wholesale, and a switch/branch starts a different one.
 */
const EPOCH_EVENTS = [
  'session_before_compact',
  'session_compact',
  'session_before_switch',
  'session_before_branch',
] as const

/**
 * Context epoch, shared by every coordinator instance in the process. Presence of a body in the
 * model's context is proved by `(epoch unchanged, identity unchanged)` — see `evidence.ts`; bumping
 * this counter is the only way that proof is withdrawn, so it lives at module scope next to the
 * events that bump it rather than inside one instance.
 */
let epoch = 0

/** The targets the coordinator may act on, in match order: the first eligible one wins. */
const DEFAULT_TARGETS: readonly DedupTarget[] = [readTarget, grepTarget]

/** The extension API surface `attach` needs: a way to subscribe to session events. */
interface EpochHost {
  on(event: string, handler: () => void): unknown
}

function isEpochHost(value: unknown): value is EpochHost {
  if (typeof value !== 'object' || value === null || !('on' in value)) return false
  return typeof value.on === 'function'
}

/**
 * `agent:` when the host exposes an agent identity, `session:` when only the process env does.
 *
 * Presence is tested the way a prototype getter is visible: `'agent' in ctx`, never `Object.keys`.
 */
function agentKeyOf(ctx: TransformContext | undefined): string | undefined {
  if (typeof ctx === 'object' && ctx !== null && 'agent' in ctx) {
    try {
      const agent: unknown = ctx.agent
      if (typeof agent === 'object' && agent !== null && 'id' in agent && typeof agent.id === 'string' && agent.id.length > 0) {
        return `agent:${agent.id}`
      }
    } catch {
      // A context whose `agent` getter throws is simply a context without an agent.
    }
  }
  const sessionId = process.env.PI_SESSION_ID
  if (typeof sessionId === 'string' && sessionId.length > 0) return `session:${sessionId}`
  return undefined
}

function firstCandidate(targets: readonly DedupTarget[], o: ToolObservation): DedupCandidate | undefined {
  for (const target of targets) {
    const candidate = target.extract(o)
    if (candidate !== undefined) return candidate
  }
  return undefined
}

/**
 * Replaces the one text block a candidate was extracted from, keeping every other field the host put
 * on it. `details` is deliberately out of reach here: the coordinator never writes facts, it only
 * collapses a body the model has already seen.
 */
function replaceBody(out: MutableResult, text: string): void {
  const block: unknown = out.content[0]
  const keep = typeof block === 'object' && block !== null && 'type' in block && typeof block.type === 'string'
  out.content[0] = keep ? { ...block, text } : { type: 'text', text }
}

/**
 * Ties store + evidence + rewrite + targets into the single `dedup/read` transform.
 *
 * Identity probe — recorded, not assumed. A `tool_result` payload carries no session or agent id,
 * and the handler's second argument exposes only `ui` as an own key
 * (docs/porting/spike-report.md:204), yet `agent` / `sessionManager` could still be prototype
 * getters, so this reads the property (`'agent' in ctx`) rather than enumerating keys. **Observed on
 * a live host: `ctx` has no `agent`, so the effective key is `session:<process.env.PI_SESSION_ID>`
 * (spike-report.md:215 — the only identifier the host hands out on every path).** `agent:<id>` is
 * still tried first so a host that exposes one gets per-agent isolation instead of a single key
 * shared by subagents. With neither, dedup does nothing at all: an unkeyed record is a claim about
 * a context we cannot identify.
 *
 * `targets` is the coordinator's only seam; the barrel passes nothing today and gets read + grep.
 */
export function createDedup(targets: readonly DedupTarget[] = DEFAULT_TARGETS): Transform {
  const store = createStore()

  return {
    name: 'dedup/read',
    features: ['dedup'],

    apply(o, out, ctx) {
      // Nothing a tool result contains may become an exception: a broken dedup slice must leave the
      // result exactly as the host produced it.
      try {
        const agentKey = agentKeyOf(ctx)
        if (agentKey === undefined) return

        if (MUTATING[o.tool] === true) {
          if (!o.isError) store.forget(agentKey)
          return
        }

        const candidate = firstCandidate(targets, o)
        if (candidate === undefined) return

        const record = store.lookup(agentKey, epoch, candidate.key)
        if (record === undefined) {
          store.remember({
            ...candidate,
            agentKey,
            epoch,
            bytes: Buffer.byteLength(candidate.body, 'utf8'),
            ...(o.callId === undefined ? {} : { callId: o.callId }),
          })
          return
        }

        // A hit whose proof fails stays a miss and keeps the verbatim body. The record is left in
        // place rather than refreshed: the store is keyed by identity, so a failed proof means we
        // cannot vouch for anything about it.
        if (!proveRecord(record, { agentKey, epoch, identity: candidate.identity })) return

        // The reference must name the call that actually carries the body in context — the one the
        // record was taken from — not this call, whose text is about to be replaced by the
        // reference itself. (Verified against the DSH original, `src/modes/native/read-dedup.ts`:
        // `unchangedContent(observation.body, entry.callId, messageId)`.)
        const rewrite = rewriteBody(record.body, record.callId ?? o.callId ?? '', undefined)
        if (rewrite === undefined) return
        replaceBody(out, rewrite.text)
      } catch {
        return
      }
    },

    attach(host) {
      try {
        if (!isEpochHost(host)) return
        const bump = (): void => {
          epoch += 1
        }
        for (const event of EPOCH_EVENTS) host.on(event, bump)
      } catch {
        return
      }
    },
  }
}
