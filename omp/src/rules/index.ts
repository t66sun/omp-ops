import { registerTransform, type Transform } from '../pipeline.ts'
import { transform as bash } from './bash.ts'
import { transform as file } from './file.ts'
import { transform as search } from './search.ts'
import { transform as evalRule } from './eval.ts'

export const rules: readonly Transform[] = [bash, file, search, evalRule]

// Registration lives in the barrel so a slice edits only its own rule file: importing this module
// is the one place the pipeline learns which rules exist.
for (const rule of rules) registerTransform(rule)
