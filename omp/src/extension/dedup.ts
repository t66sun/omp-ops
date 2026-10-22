/**
 * The read-dedup feature: a re-read that proves it is unchanged becomes a short reference line.
 *
 * The transform and its coordinator are registered by the barrel's import, and the coordinator uses
 * `attach` to observe session events (compaction, branch, switch) because those are the only moments a
 * body already in the context can stop being there.
 */
import { createHandler } from './handler.ts'
import '../dedup/index.ts'
import { attachTransforms } from '../pipeline.ts'

export interface ExtensionApi {
  on(event: string, handler: (payload: unknown) => unknown): void
}

export default function dedup(pi: ExtensionApi): void {
  pi.on('tool_result', createHandler(['dedup']))
  attachTransforms(pi)
}
