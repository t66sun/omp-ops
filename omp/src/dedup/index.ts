import type { DedupTarget } from './types.ts'
import { createStore } from './store.ts'
import { identityOf } from './evidence.ts'
import { rewriteBody } from './rewrite.ts'
import { createDedup } from './coordinator.ts'
import { readTarget } from './targets/read.ts'
import { grepTarget } from './targets/grep.ts'

export const dedupTargets: readonly DedupTarget[] = [readTarget, grepTarget]

export { createStore, identityOf, rewriteBody, createDedup }
