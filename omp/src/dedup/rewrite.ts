import type { Rewrite } from './types.ts'

/** A read body's rendered line prefix, e.g. `12 | code` or `12|code`. */
const LINE_NUMBER = /^\d+(?: \| |\|)/

/**
 * Builds the replacement body for a read whose content the model has already seen and whose
 * revision is still valid. Returns `undefined` when the compacted form is not strictly shorter
 * than `body`: a rewrite that does not save bytes is pure loss, so the caller keeps the original.
 */
export function rewriteBody(body: string, callId: string, messageId?: string): Rewrite | undefined {
  const kept = body
    .split('\n')
    .filter((line) => !LINE_NUMBER.test(line))
    .map((line) =>
      line
        .replace(/^(\[Notice: \d+ items?) displayed;/, '$1 revalidated;')
        .replace(/requested ranges returned\./, 'requested ranges revalidated.'),
    )
  // The single line that names where the body already lives. JSON-quoting keeps ids unambiguous.
  const where =
    messageId === undefined
      ? `tool call ${JSON.stringify(callId)}`
      : `tool call ${JSON.stringify(callId)} / message ${JSON.stringify(messageId)}`
  const notice = `[Notice: Unchanged file range; body already present in the current model context in ${where}. Fresh read revalidated the revision above.]`
  const compact = [...kept, notice].join('\n')
  return Buffer.byteLength(compact, 'utf8') < Buffer.byteLength(body, 'utf8') ? { text: compact } : undefined
}
