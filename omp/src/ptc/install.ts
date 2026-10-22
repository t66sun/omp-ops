/**
 * Wiring for the PTC surface. A slice answers *how* `ops` reaches a kernel; this decides whether the
 * answer is worth acting on.
 *
 * Registration is deliberately late. `installPrelude` is async, and a transform registered before its
 * verdict would have to guess the channel. Registering after it means the hint exists exactly where
 * `%load` is the channel — on a host that grows a real prelude registrar, `ops` is already installed and
 * the hint would be a lie, so it is never registered at all.
 *
 * The window this opens is one call wide and empty in practice: `eval` cannot appear in a transcript
 * before the session has started, and this settles in the same tick as the factory.
 */
import { registerTransform } from '../pipeline.ts'
import { createHint } from './hint.ts'
import { installPrelude } from './prelude.ts'

let attached = false

/**
 * Resolve the channel and register the load hint when `%load` is the only way in. Idempotent, never
 * throws: a second call is a no-op, and a host that is not one of ours installs nothing.
 */
export const attachOps = async (host: unknown): Promise<void> => {
  if (attached) return
  try {
    const channel = await installPrelude(host)
    if (channel !== 'load-file') return
    if (attached) return
    attached = true
    registerTransform(createHint())
  } catch {
    // A host we cannot read is a host we cannot improve; leaving the hint unregistered is the safe end.
  }
}

/** Test seam: forget the one-shot latch so a suite can drive several hosts. */
export const resetOpsAttachment = (): void => {
  attached = false
}
