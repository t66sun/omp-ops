/**
 * How `ops` becomes visible inside an `eval` cell.
 *
 * omp owns the prelude channel: preludes are constructed inside the host session from built-in
 * definitions, and no page documents an extension-facing registration method. So installation is a
 * probe, and its verdict is a value rather than a promise of success:
 *
 * - `'prelude'`  — the host exposed a registrar and accepted the `ops` definition
 * - `'load-file'` — no registrar exists here, but this is an omp extension host, whose `eval` tool
 *   can install the script at {@link OPS_PRELUDE_PATH} with `%load`
 * - `'none'`      — the host is not one we can install into
 *
 * The path is published rather than checked: the script comes from the JavaScript slice, so this
 * module must answer before that file exists, and a missing file is a fact for the caller to read
 * from disk, not a verdict to guess here.
 */
import { fileURLToPath } from 'node:url'

/** One of the three channels `ops` can be installed through. Never prose, never a boolean. */
export type PreludeInstall = 'prelude' | 'load-file' | 'none'

/** Absolute path of the script a `%load` instruction must name. */
export const OPS_PRELUDE_PATH: string = fileURLToPath(new URL('./js/ops.mjs', import.meta.url))

const PRELUDE_NAME = 'ops'
const PRELUDE_EXPORTS = ['ops'] as const
const PRELUDE_DOCUMENTATION = '# ops\n\nTool calls as typed outcomes: `await ops.read({ path })`.'
const PRELUDE_REGISTRAR = 'registerEvalPrelude'

/** The extension surfaces every omp host has; their presence is what makes `%load` reachable. */
const HOST_METHODS = ['registerTool', 'registerCommand', 'registerShortcut', 'on'] as const

/**
 * The host as a bag of members, or `undefined` when it is not an omp extension host at all.
 * A primitive host carries no members, so it can neither register nor load.
 */
const asHost = (host: unknown): Record<string, unknown> | undefined => {
  if (typeof host !== 'object' || host === null) return undefined
  const api = host as Record<string, unknown>
  return HOST_METHODS.some((method) => typeof api[method] === 'function') ? api : undefined
}

/**
 * One attempt per host, kept as the in-flight promise so two callers in the same turn share one
 * registration instead of racing to install twice.
 */
const attempts = new WeakMap<object, Promise<PreludeInstall>>()

const register = async (api: Record<string, unknown>): Promise<PreludeInstall> => {
  let registrar: unknown
  try {
    registrar = api[PRELUDE_REGISTRAR]
  } catch {
    // An unreadable member is a host we cannot register with, not a failed installation.
    return 'load-file'
  }
  if (typeof registrar !== 'function') return 'load-file'
  const definition = {
    name: PRELUDE_NAME,
    exports: [...PRELUDE_EXPORTS],
    module: OPS_PRELUDE_PATH,
    documentation: PRELUDE_DOCUMENTATION,
  }
  try {
    const accepted = await (registrar as (value: unknown) => unknown).call(api, definition)
    // A registrar that refuses says so; a void one has accepted, which is how the host's own
    // built-in preludes are installed. Anything else is not a refusal we can honour as a failure.
    return accepted === false ? 'load-file' : 'prelude'
  } catch {
    return 'load-file'
  }
}

/**
 * Install `ops` into the host, or report the channel that has to do it instead.
 *
 * Never throws and never rejects: a host that throws while being inspected, a registrar that
 * rejects, and a non-host all resolve to a channel name.
 */
export const installPrelude = async (host: unknown): Promise<PreludeInstall> => {
  try {
    const api = asHost(host)
    if (!api) return 'none'
    const pending = attempts.get(api)
    if (pending) return await pending
    const attempt = register(api)
    attempts.set(api, attempt)
    return await attempt
  } catch {
    return 'none'
  }
}
