/**
 * The PTC feature: the typed `ops` surface inside `eval` cells.
 *
 * There is no prelude registration API in omp 18.12.6, so the SDK reaches a kernel only through
 * `%load`. This entry therefore installs the *hint*: a transform that answers the first `NameError` for
 * `ops` with the exact paths a caller has to load. It is registered after `installPrelude` resolves, and
 * the handler reads the registry per call, so a late registration still gets dispatched.
 */
import { createHandler } from './handler.ts'
import { attachOps } from '../ptc/install.ts'

export interface ExtensionApi {
  on(event: string, handler: (payload: unknown) => unknown): void
}

export default function ptc(pi: ExtensionApi): void {
  pi.on('tool_result', createHandler(['ptc']))
  void attachOps(pi)
}
