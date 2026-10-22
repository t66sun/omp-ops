/**
 * The one thing a model cannot guess: that `ops` has to be loaded into an eval kernel before it
 * exists.
 *
 * omp 18.12.6 has no extension-facing eval-prelude API, so the only channel is `%load` inside a cell
 * (proven live for both runtimes). A model that writes `await ops.read({…})` on its first try gets
 * `NameError`/`ReferenceError`, which is exactly the retry loop this project exists to prevent. So the
 * hint rides the failure rather than pre-announcing itself: no session pays for it unless a cell
 * actually reached for `ops` without loading it.
 *
 * It appends one line to the last text block. That is a `content` write outside the renderer, which is
 * deliberate and narrow: the renderer only ever appends an outcome line, so the two lines stack in a
 * fixed order, and this transform refuses to run twice.
 */
import { fileURLToPath } from 'node:url'

import type { ToolObservation } from '../host/contracts.ts'
import type { MutableResult, Transform } from '../pipeline.ts'

/** Absolute path of the JavaScript helper. Must stay a script: `%load` rejects `export`. */
export const OPS_JS_PATH = fileURLToPath(new URL('./js/ops.mjs', import.meta.url))

/** Absolute path of the Python helper, which publishes `create_ops` the same way. */
export const OPS_PY_PATH = fileURLToPath(new URL('./py/ops.py', import.meta.url))

/** Present in the failure text of an unloaded kernel in either language. */
const UNDEFINED = /(?:NameError|ReferenceError)[^\n]*is not defined|is not defined/

/** The names a caller would reach for before loading the helper. */
const OPS_NAME = /\b(?:ops|createOps|create_ops)\b/

/** Already answered, so a second failing cell in the same transcript is not nagged. */
const ALREADY = '%load'

const isText = (block: unknown): block is { type: 'text'; text: string } => {
  if (typeof block !== 'object' || block === null) return false
  if (!('type' in block) || !('text' in block)) return false
  return block.type === 'text' && typeof block.text === 'string'
}

/** The whole observation is a failing eval cell whose text names `ops` without ever loading it. */
const explains = (o: ToolObservation): boolean => {
  if (o.tool !== 'eval' || !o.isError) return false
  let text = ''
  for (const block of o.content) if (isText(block)) text += `${block.text}\n`
  if (text === '' || text.includes(ALREADY)) return false
  return UNDEFINED.test(text) && OPS_NAME.test(text)
}

const hint = (): string =>
  `[ops: load the SDK once per kernel with %load "${OPS_JS_PATH}" (js) or %load "${OPS_PY_PATH}" (py), then await ops.read({...})]`

/** Build the transform. Exported so a test can drive it without a host. */
export const createHint = (): Transform => ({
  name: 'ptc/hint',
  features: ['ptc'],
  apply(o: ToolObservation, out: MutableResult): void {
    if (!explains(o)) return
    const last = out.content.at(-1)
    if (!isText(last)) return
    out.content[out.content.length - 1] = { ...last, text: `${last.text}\n${hint()}` }
  },
})
