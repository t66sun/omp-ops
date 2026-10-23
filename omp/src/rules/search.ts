import { OUTCOME_KEY, isMutableDetails, readOutcome, type OutcomeFacts, type ToolObservation } from '../host/contracts.ts'
import { grepFacts, type GrepFacts } from '../host/guards.ts'
import { coverageOf } from '../kernel/coverage.ts'
import { errorPolicy } from '../kernel/errors.ts'
import type { CoverageMeta } from '../kernel/outcome.ts'
import type { Transform } from '../pipeline.ts'

/**
 * Coverage facts for the two search tools.
 *
 * omp's `grep` reports *pagination flags*, not an `isComplete`. This rule turns those flags into
 * `coverage.isComplete`, so a search that stopped early can never reach the model as a complete
 * scan, and so the observed counts are never presented as a total.
 *
 * Evidence (omp 18.12.6, probe extension logging the raw `tool_result`; the full transcript is in
 * `docs/porting/spike-report.md`). A 300-file tree with 10 matching lines per file — 3000 matches,
 * searched in one call from `C:/Users/Toshu/AppData/Local/Temp`:
 *
 * page 0 (`details.files` / `fileMatches` / `displayContent` elided, 20 paths fill them):
 * {"scopePath":".","searchPath":"C:/Users/Toshu/AppData/Local/Temp/omp-rules-search-fixture",
 *  "cwd":"C:\\Users\\Toshu\\AppData\\Local\\Temp\\omp-rules-search-fixture","matchCount":200,
 *  "fileCount":20,"truncated":true,"fileLimitReached":20}
 *
 * page at `skip: 199` — the last file the scan ever reports:
 * {"scopePath":".","searchPath":"C:/Users/Toshu/AppData/Local/Temp/omp-rules-search-fixture",
 *  "cwd":"C:\\Users\\Toshu\\AppData\\Local\\Temp\\omp-rules-search-fixture","matchCount":10,
 *  "fileCount":1,"files":["f199.txt"],"fileMatches":[{"path":"f199.txt","count":10}],
 *  "truncated":true,"displayContent":"# f199.txt\n *1│line 0 needle 199\n ... *10│line 9 needle 199"}
 *
 * page at `skip: 200` — a clean end-of-results, with 100 matching files never scanned:
 * {"scopePath":".","searchPath":"C:/Users/Toshu/AppData/Local/Temp/omp-rules-search-fixture",
 *  "cwd":"C:\\Users\\Toshu\\AppData\\Local\\Temp\\omp-rules-search-fixture","matchCount":0,
 *  "fileCount":0,"files":[],"truncated":false}
 *
 * Verdict on the internal `maxCount: 2000` cap: it clips *silently at the scan level* — the scan
 * stops once it has collected 2000 matches (200 files x 10 here; a 300-file tree with 5 matches per
 * file has no cap at all, and a 120-file tree with 40 matches each stops at 96 files), and the page
 * where that happens is indistinguishable from "the tree has nothing more": `matchCount: 0`,
 * `fileCount: 0`, `truncated: false`, no limit key. The cap never leaks into a count, though — a
 * page is capped at 20 files and 20 matches per file (200 matches for a single-file search), so
 * `matchCount` cannot reach 2000 and `matchCount === 2000` is not a signal any caller can observe.
 * Rewriting a page as "complete" because no flag is set would therefore be wrong for a *paged*
 * call, which is why a continuation (`skip > 0`) is never reported as a complete scan below.
 */

/** The only failure vocabulary a coverage gap has: the query was too broad for the budget. */
const BUDGET_CODE = 'OUTPUT_LIMIT'
/** A requested path did not exist. Same retry advice, different cause. */
const MISSING_CODE = 'NOT_FOUND'
/**
 * The policy table has no success code. Every settled code answers `never`, which is exactly the
 * advice for a scan that was not cut — so the answer is derived, never written as a literal.
 */
const SETTLED_CODE = 'CANCELLED'

const TIMEOUT = /\btimed?\s*out\b|\btimeout\b|\btime limit\b/i

function textOf(content: readonly unknown[]): string {
  const parts: string[] = []
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue
    const text = (part as Record<string, unknown>)['text']
    if (typeof text === 'string') parts.push(text)
  }
  return parts.join('')
}

/** A positive `skip` means this is one page of a scan, never the whole scan. */
function isPaged(args: unknown): boolean {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return false
  const skip = (args as Record<string, unknown>)['skip']
  return typeof skip === 'number' && skip > 0
}

/**
 * Most specific cause first. `skip: 199` above proves a bare `truncated` cannot mean "output was
 * cut" — one file with ten short lines was reported in full — so only `linesTruncated` is an
 * output gap; every other flag is the scan stopping.
 */
function causeOf(facts: GrepFacts, timedOut: boolean): CoverageMeta['truncatedBy'] {
  if (timedOut) return 'time-limit'
  if (facts.linesTruncated) return 'output-budget'
  if (facts.truncated || facts.fileLimitReached || facts.perFileLimitReached) return 'scan-budget'
  return undefined
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

function cutBy(facts: GrepFacts, timedOut: boolean): string {
  if (timedOut) return 'grep timed out before the scan finished'
  if (facts.linesTruncated) return 'grep cut long matching lines to the column limit'
  if (facts.fileLimitReached) return 'grep stopped at the file limit'
  if (facts.perFileLimitReached) return 'grep stopped at the per-file match limit'
  if (facts.truncated) return 'grep stopped before the scan finished'
  return 'grep returned one page of a paged scan'
}

function partialMessage(facts: GrepFacts, timedOut: boolean): string {
  const observed = `observed ${count(facts.matchCount, 'match', 'matches')} in ${count(facts.fileCount, 'file', 'files')}`
  return `${cutBy(facts, timedOut)}: ${observed}, total unknown.`
}

/**
 * Grep's own numbers, reduced to a coverage claim. `matchedCount` carries the observed page only;
 * `OutcomeFacts` has no total field on purpose, so a partial result cannot leak one. `scannedFiles`
 * is never published: `grep` reports how many files *matched*, not how many it examined, so writing
 * that number there would claim work that may not have happened — the one thing this rule exists to
 * prevent.
 *
 * `status` comes from the coverage formula, not from the error policy: search results speak the
 * kernel's coverage vocabulary (`completed`/`partial`), which `FailureStatus` cannot express. The
 * policy still owns `retry`, so no replay advice is ever written by hand.
 */
function grepOutcome(o: ToolObservation): OutcomeFacts | undefined {
  const timedOut = TIMEOUT.test(textOf(o.content))
  const facts = grepFacts(o)
  if (facts === undefined) {
    if (!timedOut) return undefined
    return {
      status: 'partial',
      effectState: 'none',
      retry: errorPolicy(BUDGET_CODE, 'none').retry,
      code: BUDGET_CODE,
      message: 'grep timed out before the scan finished: no matches observed, total unknown.',
      nextAction: 'Narrow the pattern or scope the path, then search again.',
      coverage: { matchedCount: 0, isComplete: false, truncatedBy: 'time-limit' },
    }
  }
  // An error payload with match counts is not a scan anyone can count on; leave it to the failure
  // rules unless the message itself reports a timeout, which is a coverage fact.
  if (o.isError && !timedOut) return undefined

  const paged = isPaged(o.args)
  const isComplete =
    !timedOut &&
    !facts.truncated &&
    !facts.fileLimitReached &&
    !facts.perFileLimitReached &&
    !facts.linesTruncated &&
    facts.missingPaths === 0 &&
    !paged
  if (isComplete) {
    return {
      status: 'completed',
      effectState: 'none',
      // Derived, never literal. A complete scan has no error code at all: publishing one would
      // tell a consumer that a successful search was cancelled.
      retry: errorPolicy(SETTLED_CODE, 'none').retry,
      message: `grep returned ${count(facts.matchCount, 'match', 'matches')} in ${count(facts.fileCount, 'file', 'files')}; coverage complete.`,
      coverage: coverageOf({ matchedCount: facts.matchCount, scanComplete: true }),
    }
  }

  const truncatedBy = causeOf(facts, timedOut) ?? (paged ? 'row-limit' : undefined)
  const coverage: CoverageMeta = coverageOf({
    matchedCount: facts.matchCount,
    scanComplete: false,
    ...(truncatedBy === undefined ? {} : { truncatedBy }),
  })
  const missing = facts.missingPaths > 0
    ? ` ${count(facts.missingPaths, 'requested path', 'requested paths')} did not exist and was not searched.`
    : ''
  return {
    status: 'partial',
    effectState: 'none',
    retry: errorPolicy(missing ? MISSING_CODE : BUDGET_CODE, 'none').retry,
    code: missing ? MISSING_CODE : BUDGET_CODE,
    message: `${partialMessage(facts, timedOut)}${missing}`,
    nextAction: missing
      ? 'Correct the missing path, then search again.'
      : 'Narrow the pattern or scope the path, then search again.',
    coverage,
  }
}

const GLOB_CUT_KEY = 'resultLimitReached'

/**
 * `glob` has no coverage accounting at all — no `matchCount`, no cause. Its only incomplete shape is
 * a listing cut at `resultLimitReached`, which is a row window over the file list, so that is the
 * only shape this rule reports; a listing that was not cut gets no facts.
 */
function globOutcome(o: ToolObservation): OutcomeFacts | undefined {
  if (o.isError) return undefined
  const details = o.details
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return undefined
  const record = details as Record<string, unknown>
  const cut = record['truncated'] === true || record[GLOB_CUT_KEY] !== undefined
  if (!cut) return undefined
  const fileCount = record['fileCount']
  const listed = typeof fileCount === 'number' ? fileCount : 0
  return {
    status: 'partial',
    effectState: 'none',
    retry: errorPolicy(BUDGET_CODE, 'none').retry,
    code: BUDGET_CODE,
    message: `glob listed ${count(listed, 'path', 'paths')} and stopped at the result limit: more files exist than were shown, total unknown.`,
    nextAction: 'Narrow the glob or scope the path, then list again.',
    coverage: { matchedCount: listed, isComplete: false, truncatedBy: 'row-limit' },
  }
}

function classify(o: ToolObservation): OutcomeFacts | undefined {
  if (o.tool === 'grep') return grepOutcome(o)
  if (o.tool === 'glob') return globOutcome(o)
  return undefined
}

export const transform: Transform = {
  name: 'rules/search',
  features: ['honesty'],
  apply(o, out) {
    if (!isMutableDetails(out.details)) return
    if (readOutcome(out.details) !== undefined) return
    const facts = classify(o)
    if (facts === undefined) return
    out.details[OUTCOME_KEY] = facts
  },
}
