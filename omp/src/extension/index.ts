/**
 * The single extension entry, and the only file omp loads.
 *
 * Two host facts decided this shape, both measured rather than assumed:
 *
 * 1. Each extension entry gets its own module graph, so two entries cannot share a transform registry.
 * 2. A marketplace install loads `omp.extensions` and nothing else — `omp.features` selects *files* for
 *    an npm/link install, but the marketplace path never reads it, so a feature entry is unreachable
 *    there. Splitting the features into entries would ship a plugin that loads and does nothing.
 *
 * So: one entry, one `tool_result` handler, and every feature's transforms registered in this graph by
 * the imports below. Import order is run order — rules publish facts, the renderer writes the line, the
 * dedup coordinator and the PTC hint come after.
 */
import { createHandler } from './handler.ts'
import { attachTransforms } from '../pipeline.ts'
import '../rules/index.ts'
import '../render/index.ts'
import '../dedup/index.ts'
import { attachOps } from '../ptc/index.ts'

export interface ExtensionApi {
  on(event: string, handler: (payload: unknown) => unknown): void
}

export default function ompOps(pi: ExtensionApi): void {
  pi.on('tool_result', createHandler(['honesty', 'dedup', 'ptc']))
  attachTransforms(pi)
  void attachOps(pi)
}
