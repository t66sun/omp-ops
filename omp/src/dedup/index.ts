import { registerTransform } from '../pipeline.ts'
import type { DedupTarget } from './types.ts'
import { createStore } from './store.ts'
import { identityOf, proveRecord } from './evidence.ts'
import { rewriteBody } from './rewrite.ts'
import { createDedup } from './coordinator.ts'
import { readTarget } from './targets/read.ts'
import { grepTarget } from './targets/grep.ts'

export const dedupTargets: readonly DedupTarget[] = [readTarget, grepTarget]

/**
 * Registered at import time so no slice ever has to touch this barrel. `createDedup` receives the
 * targets it may act on; the coordinator decides which one matches a given observation.
 */
export const dedupTransform = createDedup()
registerTransform(dedupTransform)

export { createStore, identityOf, proveRecord, rewriteBody, createDedup }
