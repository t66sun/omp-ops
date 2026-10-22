import { readOutcome, type OutcomeFacts } from '../host/contracts.ts'
import type { Transform } from '../pipeline.ts'

/** The one content-block shape this slice understands; anything else is left alone. */
interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

function isTextBlock(value: unknown): value is TextBlock {
  if (typeof value !== 'object' || value === null) return false
  const block = value as Record<string, unknown>
  return block.type === 'text' && typeof block.text === 'string'
}

/**
 * The last text block and its position, if any. The renderer appends to the final text block
 * because a tool result may carry images, structured blocks or an empty array — none of which may
 * be invented over.
 */
function lastTextBlock(content: readonly unknown[]): { index: number; block: TextBlock } | undefined {
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const block = content[i]
    if (isTextBlock(block)) return { index: i, block }
  }
  return undefined
}

function renderLine(facts: OutcomeFacts): string {
  const base = `[outcome: ${facts.status} · effect ${facts.effectState} · retry ${facts.retry}] ${facts.message}`
  const next = facts.nextAction
  return typeof next === 'string' && next.length > 0 ? `${base} Next: ${next}` : base
}

/**
 * True when the block already carries this exact line as its last line. Trailing newlines are
 * ignored so a host that keeps a block newline-terminated cannot make the banner duplicate; the
 * line itself is still matched verbatim, not by substring.
 */
function alreadyRendered(text: string, line: string): boolean {
  const trimmed = text.replace(/[\r\n]+$/, '')
  return trimmed === line || trimmed.endsWith(`\n${line}`)
}

/**
 * Runs last so every rule has already published its facts. Turns `details['outcome.v1']` into one
 * model-visible line, and is the only Round 1 transform allowed to touch `content`.
 *
 * A successful call is byte-identical afterwards, a richer result is never replaced by the banner,
 * and a second pass appends nothing.
 */
export const transform: Transform = {
  name: 'honesty/render',
  features: ['honesty'],
  apply(_o, out) {
    const facts = readOutcome(out.details)
    // `completed` needs no banner: this transform may only add text where something went wrong.
    if (facts === undefined || facts.status === 'completed') return

    const target = lastTextBlock(out.content)
    if (target === undefined) return

    const { index, block } = target
    const line = renderLine(facts)
    if (alreadyRendered(block.text, line)) return

    const separator = block.text.endsWith('\n') ? '' : '\n'
    // Replace the block instead of mutating it: the extension detects changed content by identity,
    // so an in-place edit would never reach the host.
    out.content[index] = { ...block, text: `${block.text}${separator}${line}` }
  },
}
