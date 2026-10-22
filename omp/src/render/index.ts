import { registerTransform } from '../pipeline.ts'
import { transform as outcomeLine } from './outcome-line.ts'

// Registered from the barrel, like `rules/index.ts`, so the `honesty/render` slice edits only its
// own file. The extension imports the rule barrel first, so the renderer always runs after the
// rules that publish `details['outcome.v1']`.
registerTransform(outcomeLine)

export { outcomeLine }
