import type { Rewrite } from './types.ts'

/** A read body's rendered line prefix, e.g. `12 | code` or `12|code`. */
const LINE_NUMBER = /^\d+(?: \| |\|)/

/** The longest subject line a rewrite will carry; a path longer than this is already the body. */
const MAX_SUBJECT = 200

/** The phrase that marks a body as already rewritten, so a second pass is a no-op. */
const REFERENCE_MARKER = '[Notice: Unchanged file range;'

/**
 * Builds the replacement body for a read whose content the model has already seen and whose
 * revision is still valid. Returns `undefined` when the compacted form is not strictly shorter
 * than `body`: a rewrite that does not save bytes is pure loss, so the caller keeps the original.
 *
 * Two shapes are compacted, because two hosts render read output differently:
 *
 * - A **numbered** body (DSH renders `12 | code`) loses its numbered lines and keeps whatever
 *   unnumbered lines remain — headers, notices — so the model still sees the framing but not the
 *   text it already has.
 * - An **unnumbered** body (omp's `read` emits plain text; measured twice in one session, no `N |`
 *   prefix and no `[path#TAG]` header) has nothing to strip, and keeping it would make the notice
 *   longer than the body it replaces — so the body is dropped and only `subject` plus the reference
 *   line remain. The subject is what keeps the notice actionable: without it the model is told
 *   "somewhere above" with no path.
 */
export function rewriteBody(body: string, callId: string, messageId?: string, subject?: string): Rewrite | undefined {
  // A body that already carries the reference line has been compacted once; compacting it again
  // would strip the framing that survived the first pass and gain nothing the model can use.
  if (body.includes(REFERENCE_MARKER)) return undefined
  const lines = body.split('\n')
  const kept = lines
    .filter((line) => !LINE_NUMBER.test(line))
    .map((line) =>
      line
        .replace(/^(\[Notice: \d+ items?) displayed;/, '$1 revalidated;')
        .replace(/requested ranges returned\./, 'requested ranges revalidated.'),
    )
  const strippedSomething = kept.length !== lines.length
  // The single line that names where the body already lives. JSON-quoting keeps ids unambiguous.
  const where =
    messageId === undefined
      ? `tool call ${JSON.stringify(callId)}`
      : `tool call ${JSON.stringify(callId)} / message ${JSON.stringify(messageId)}`
  const notice = `[Notice: Unchanged file range; body already present in the current model context in ${where}. Fresh read revalidated the revision above.]`

  const head = strippedSomething ? kept : subject === undefined ? [] : [subject.slice(0, MAX_SUBJECT)]
  const compact = [...head, notice].join('\n')
  return Buffer.byteLength(compact, 'utf8') < Buffer.byteLength(body, 'utf8') ? { text: compact } : undefined
}
