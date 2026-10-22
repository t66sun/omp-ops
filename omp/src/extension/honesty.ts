/**
 * The honesty feature: every rule publishes a typed fact into `details["outcome.v1"]`, and the renderer
 * turns it into one model-visible line.
 *
 * The two imports below are the whole wiring. `rules/index.ts` registers the four rules in a fixed
 * order and `render/index.ts` registers the single line writer after them, so a feature entry is a list
 * of side-effect imports plus one handler over exactly those transforms.
 */
import { createHandler } from './handler.ts'
import '../rules/index.ts'
import '../render/index.ts'
import { attachTransforms } from '../pipeline.ts'

export interface ExtensionApi {
  on(event: string, handler: (payload: unknown) => unknown): void
}

export default function honesty(pi: ExtensionApi): void {
  pi.on('tool_result', createHandler(['honesty']))
  attachTransforms(pi)
}
