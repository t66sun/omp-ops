import assert from 'node:assert/strict'
import { test } from 'node:test'
import { observe, type ToolObservation } from '../src/host/contracts.ts'
import { bashFacts, grepFacts, readFacts } from '../src/host/guards.ts'

/**
 * Every payload below was captured from omp 18.12.6 (`omp -p`) through a probe extension that
 * appended the raw `tool_result` event to a log. `docs/porting/spike-report.md` holds the rest of
 * the transcript; large `displayContent` strings were dropped where a guard never reads them, and
 * each such omission is marked.
 */

const observation = (raw: unknown): ToolObservation => {
  const observed = observe(raw)
  assert.ok(observed, 'fixture must be a wire payload the host actually sends')
  return observed
}

// bash, `echo`-style success: no exitCode at all.
const bashSuccess = observation({
  type: 'tool_result',
  toolName: 'bash',
  toolCallId: 'call_00_0tzf9pz00jju6iw4kkkw9lea',
  input: { command: 'echo denied-probe' },
  content: [],
  details: { wallTimeNoticeEmitted: false, timeoutSeconds: 60, wallTimeMs: 85.48440000000028 },
  isError: false,
})

// bash, `echo out; exit 3`.
const bashExit3 = observation({
  type: 'tool_result',
  toolName: 'bash',
  toolCallId: 'call_00_TOqebqvY4RlYDcMN7QEO2956',
  input: { command: 'echo out; exit 3', timeout: 60 },
  content: [{ type: 'text', text: 'out\n\n\nCommand exited with code 3' }],
  details: { wallTimeNoticeEmitted: false, timeoutSeconds: 60, wallTimeMs: 76.60339999999997, exitCode: 3 },
  isError: true,
})

// bash, `timeout: 3` against a command that ran past it.
const bashTimeout = observation({
  type: 'tool_result',
  toolName: 'bash',
  toolCallId: 'call_00_timeout',
  input: { command: 'node -e "setTimeout(() => {}, 10000)"', timeout: 3 },
  content: [],
  details: { wallTimeNoticeEmitted: true, timeoutSeconds: 3, wallTimeMs: 3157.6731, timedOut: true },
  isError: true,
})

// bash under `--approval-mode=always-ask` with no UI: the host refuses and writes no details.
const bashDenied = observation({
  type: 'tool_result',
  toolName: 'bash',
  toolCallId: 'call_00_denied',
  input: { command: 'echo denied-probe', timeout: 60 },
  content: [
    {
      type: 'text',
      text:
        'Tool "bash" requires approval but no interactive UI available.\n' +
        'Options:\n' +
        '  1. Set tools.approvalMode: yolo in /settings\n' +
        '  2. Add tools.approval.bash: allow to config\n' +
        '  3. Use an interactive UI to approve the tool call',
    },
  ],
  isError: true,
})

// read, `read omp/src/pipeline.ts:1-5` — output cut to five lines.
const readTruncated = observation({
  type: 'tool_result',
  toolName: 'read',
  toolCallId: 'call_00_read_truncated',
  input: { path: 'omp/src/pipeline.ts:1-5' },
  content: [],
  details: {
    truncation: {
      truncated: true,
      truncatedBy: 'lines',
      totalLines: 54,
      totalBytes: 147,
      outputLines: 5,
      outputBytes: 147,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
    },
    totalLines: 54,
    rowPrefixes: false,
    displayContent: {
      text: "import type { ToolObservation } from './host/contracts.ts'\n\nexport type FeatureFlag = 'honesty' | 'dedup' | 'ptc'\n\nexport interface MutableResult {",
      startLine: 1,
      lineNumbers: [1, 2, 3, 4, 5],
    },
    fileSize: 1703,
    meta: {
      source: { type: 'path', value: 'C:\\c\\dev\\wt\\runtime\\omp\\src\\pipeline.ts' },
      pagedSource: true,
      truncation: {
        direction: 'head',
        truncatedBy: 'lines',
        totalLines: 54,
        totalBytes: 147,
        outputLines: 5,
        outputBytes: 147,
        maxBytes: 51200,
        shownRange: '<max-depth>',
        nextOffset: 6,
      },
    },
  },
  isError: false,
})

// read, `read "a.ts:1-5;b.ts:1-5"` — two targets, no meta and no truncation record.
const readMulti = observation({
  type: 'tool_result',
  toolName: 'read',
  toolCallId: 'call_00_read_multi',
  input: { path: 'omp/src/pipeline.ts:1-5;omp/src/host/contracts.ts:1-5' },
  content: [],
  details: {
    notes: ['Note: interpreted as 2 paths: omp/src/pipeline.ts:1-5, omp/src/host/contracts.ts:1-5'],
    displayReadTargets: ['omp/src/pipeline.ts:1-5', 'omp/src/host/contracts.ts:1-5'],
    displayReadTargetLinks: [
      'C:\\c\\dev\\wt\\runtime\\omp\\src\\pipeline.ts',
      'C:\\c\\dev\\wt\\runtime\\omp\\src\\host\\contracts.ts',
    ],
  },
  isError: false,
})

// read, one whole file: `meta.source` present, no truncation. `displayContent` (3 KB) dropped.
const readPaged = observation({
  type: 'tool_result',
  toolName: 'read',
  toolCallId: 'call_00_read_whole',
  input: { path: 'omp/src/kernel/errors.ts' },
  content: [],
  details: {
    totalLines: 64,
    rowPrefixes: false,
    fileSize: 3098,
    meta: {
      source: { type: 'path', value: 'C:\\c\\dev\\wt\\runtime\\omp\\src\\kernel\\errors.ts' },
      pagedSource: true,
    },
  },
  isError: false,
})

// grep over omp/src for `q`: exactly at the file cap, but the host did not flag a limit.
const grepAtCap = observation({
  type: 'tool_result',
  toolName: 'grep',
  toolCallId: 'call_00_grep_at_cap',
  input: { pattern: 'q', path: 'omp/src' },
  content: [],
  details: {
    scopePath: 'omp/src',
    searchPath: 'C:\\c\\dev\\wt\\runtime\\omp\\src',
    cwd: 'C:\\c\\dev\\wt\\runtime',
    matchCount: 20,
    fileCount: 10,
    files: [
      'omp/src/extension/index.ts',
      'omp/src/host/contracts.ts',
      'omp/src/pipeline.ts',
      'omp/src/render/index.ts',
      'omp/src/render/outcome-line.ts',
      'omp/src/rules/bash.ts',
      'omp/src/rules/eval.ts',
      'omp/src/rules/file.ts',
      'omp/src/rules/index.ts',
      'omp/src/rules/search.ts',
    ],
    truncated: false,
  },
  isError: false,
})

// grep over src for a very common token: both the file cap and the per-file cap were hit.
// The host writes the *limit values* (numbers), not booleans, and omits the key when not hit.
const grepLimits = (flags: { fileLimitReached?: unknown; perFileLimitReached?: unknown; linesTruncated?: unknown }) =>
  observation({
    type: 'tool_result',
    toolName: 'grep',
    toolCallId: 'call_00_grep_limits',
    input: { pattern: 'a', path: 'src' },
    content: [],
    details: {
      scopePath: 'src',
      searchPath: 'C:\\c\\dev\\wt\\runtime\\src',
      cwd: 'C:\\c\\dev\\wt\\runtime',
      matchCount: 379,
      fileCount: 20,
      files: ['src/authority-paths.ts'],
      truncated: true,
      ...flags,
    },
    isError: false,
  })

const grepMissing = observation({
  type: 'tool_result',
  toolName: 'grep',
  toolCallId: 'call_00_grep_missing',
  input: { pattern: 'q', path: 'omp/src;nope-dir' },
  content: [],
  details: {
    scopePath: 'omp/src',
    searchPath: 'C:\\c\\dev\\wt\\runtime\\omp\\src',
    cwd: 'C:\\c\\dev\\wt\\runtime',
    matchCount: 8,
    fileCount: 2,
    files: ['omp/src/kernel/errors.ts', 'omp/src/pipeline.ts'],
    truncated: false,
    missingPaths: ['nope-dir'],
  },
  isError: false,
})

// grep with no matches at all.
const grepNoMatch = observation({
  type: 'tool_result',
  toolName: 'grep',
  toolCallId: 'call_00_grep_none',
  input: { pattern: 'q', path: 'omp/src/kernel/errors.ts' },
  content: [],
  details: {
    scopePath: 'omp/src/kernel/errors.ts',
    searchPath: 'C:\\c\\dev\\wt\\runtime\\omp\\src\\kernel\\errors.ts',
    cwd: 'C:\\c\\dev\\wt\\runtime',
    matchCount: 0,
    fileCount: 0,
    files: [],
    truncated: false,
  },
  isError: false,
})

// glob: shares `fileCount`, `truncated` and `resultLimitReached` with grep but has no matchCount.
const globResult = observation({
  type: 'tool_result',
  toolName: 'glob',
  toolCallId: 'call_00_glob',
  input: { pattern: '**/*.ts' },
  content: [],
  details: {
    scopePath: '.',
    fileCount: 200,
    files: ['omp/src/pipeline.ts', 'tsconfig.json'],
    truncated: true,
    resultLimitReached: 200,
    cwd: 'C:\\c\\dev\\wt\\runtime',
    meta: { truncated: true },
  },
  isError: false,
})

// write that created a missing parent chain: `resolvedPath` alone, no read-shaped fields.
const writeCreated = observation({
  type: 'tool_result',
  toolName: 'write',
  toolCallId: 'call_00_write',
  input: { path: 'C:/nonexistent-probe-root/nested/file.txt', content: 'x' },
  content: [],
  details: { resolvedPath: 'C:/nonexistent-probe-root/nested/file.txt' },
  isError: false,
})

// eval whose cell threw: cells carry the error, no guard claims it.
const evalThrown = observation({
  type: 'tool_result',
  toolName: 'eval',
  toolCallId: 'call_00_eval',
  input: { language: 'js', code: "throw new Error('probe-boom')" },
  content: [],
  details: {
    language: 'js',
    languages: ['js'],
    cells: [
      {
        index: 0,
        title: 'Probe 2: throw',
        code: "throw new Error('probe-boom')",
        language: 'js',
        output: 'Error: probe-boom',
        status: 'error',
        exitCode: 1,
        durationMs: 4,
      },
    ],
    isError: true,
  },
  isError: true,
})

test('bash success and non-zero exit are neither denied nor aborted', () => {
  assert.deepEqual(bashFacts(bashSuccess), { exitCode: undefined, timedOut: false, aborted: false, denied: false })

  const failed = bashFacts(bashExit3)
  assert.ok(failed)
  assert.equal(failed.exitCode, 3)
  assert.equal(failed.denied, false, 'a failing command must never be reported as a host denial')
  assert.equal(failed.aborted, false)
  assert.equal(failed.timedOut, false)
})

test('bash timeout is reported through details, with no exit code', () => {
  const facts = bashFacts(bashTimeout)
  assert.ok(facts)
  assert.deepEqual(facts, { exitCode: undefined, timedOut: true, aborted: false, denied: false })
})

test('bash refusal without details is a denial, not a failure', () => {
  const facts = bashFacts(bashDenied)
  assert.ok(facts)
  assert.deepEqual(facts, { exitCode: undefined, timedOut: false, aborted: false, denied: true })
})

test('bash cancellation without details is an abort, not a denial', () => {
  const cancelled = observation({
    type: 'tool_result',
    toolName: 'bash',
    toolCallId: 'call_00_aborted',
    input: { command: 'sleep 30' },
    content: [{ type: 'text', text: 'partial output\n\n[Command aborted]' }],
    isError: true,
  })
  assert.deepEqual(bashFacts(cancelled), { exitCode: undefined, timedOut: false, aborted: true, denied: false })

  const plainFailure = observation({
    type: 'tool_result',
    toolName: 'bash',
    toolCallId: 'call_00_plain',
    input: { command: 'nope' },
    content: [{ type: 'text', text: 'Command failed: missing exit status' }],
    isError: true,
  })
  assert.equal(bashFacts(plainFailure), undefined, 'an unrecognised error message yields no facts')
})

test('read reports every target and whether output was cut', () => {
  assert.deepEqual(readFacts(readTruncated), {
    paths: ['C:\\c\\dev\\wt\\runtime\\omp\\src\\pipeline.ts'],
    truncated: true,
  })

  assert.deepEqual(readFacts(readMulti), {
    paths: [
      'C:\\c\\dev\\wt\\runtime\\omp\\src\\pipeline.ts',
      'C:\\c\\dev\\wt\\runtime\\omp\\src\\host\\contracts.ts',
    ],
    truncated: false,
  })

  assert.deepEqual(readFacts(readPaged), {
    paths: ['C:\\c\\dev\\wt\\runtime\\omp\\src\\kernel\\errors.ts'],
    truncated: false,
  })
})

test('grep truncation is reported independently of the two limit flags', () => {
  assert.deepEqual(grepFacts(grepAtCap), {
    matchCount: 20,
    fileCount: 10,
    truncated: false,
    fileLimitReached: false,
    perFileLimitReached: false,
    linesTruncated: false,
    missingPaths: 0,
  })

  const both = grepFacts(grepLimits({ fileLimitReached: 20, perFileLimitReached: 20 }))
  assert.ok(both)
  assert.equal(both.truncated, true)
  assert.equal(both.fileLimitReached, true)
  assert.equal(both.perFileLimitReached, true)
  assert.equal(both.linesTruncated, false)

  const filesOnly = grepFacts(grepLimits({ fileLimitReached: 20 }))
  assert.ok(filesOnly)
  assert.equal(filesOnly.fileLimitReached, true)
  assert.equal(filesOnly.perFileLimitReached, false)

  const perFileOnly = grepFacts(grepLimits({ perFileLimitReached: 20 }))
  assert.ok(perFileOnly)
  assert.equal(perFileOnly.fileLimitReached, false)
  assert.equal(perFileOnly.perFileLimitReached, true)

  const columns = grepFacts(grepLimits({ perFileLimitReached: 20, linesTruncated: true }))
  assert.ok(columns)
  assert.equal(columns.linesTruncated, true)
})

test('grep counts missing paths and tolerates an empty result', () => {
  const missing = grepFacts(grepMissing)
  assert.ok(missing)
  assert.equal(missing.missingPaths, 1)
  assert.equal(missing.matchCount, 8)
  assert.equal(missing.fileCount, 2)

  const empty = grepFacts(grepNoMatch)
  assert.ok(empty)
  assert.deepEqual(empty, {
    matchCount: 0,
    fileCount: 0,
    truncated: false,
    fileLimitReached: false,
    perFileLimitReached: false,
    linesTruncated: false,
    missingPaths: 0,
  })
})

test('a payload from another tool is not read as one of ours', () => {
  assert.equal(grepFacts(globResult), undefined, 'glob shares fileCount and truncated but is not a search')
  assert.equal(readFacts(writeCreated), undefined, 'write reports resolvedPath too')
  assert.equal(bashFacts(evalThrown), undefined)
  assert.equal(readFacts(evalThrown), undefined)
  assert.equal(grepFacts(evalThrown), undefined)
  assert.equal(bashFacts(bashSuccess) === undefined, false, 'the same payload under its own name is read')
})

test('unknown or malformed details return undefined instead of throwing', () => {
  const junk: unknown[] = [
    { type: 'tool_result', toolName: 'bash', content: [], isError: false },
    { type: 'tool_result', toolName: 'bash', content: [], details: {}, isError: false },
    { type: 'tool_result', toolName: 'bash', content: [], details: null, isError: true },
    { type: 'tool_result', toolName: 'bash', content: [], details: 'nope', isError: false },
    { type: 'tool_result', toolName: 'bash', content: [], details: [1, 2], isError: false },
    { type: 'tool_result', toolName: 'read', content: [], details: {}, isError: false },
    { type: 'tool_result', toolName: 'read', content: [], details: { isDirectory: true }, isError: false },
    { type: 'tool_result', toolName: 'grep', content: [], details: { input: { pattern: 'x' } }, isError: true },
    { type: 'tool_result', toolName: 'grep', content: [], details: { matchCount: '20', fileCount: 10 }, isError: false },
  ]
  for (const raw of junk) {
    const o = observation(raw)
    assert.doesNotThrow(() => {
      assert.equal(bashFacts(o), undefined)
      assert.equal(readFacts(o), undefined)
      assert.equal(grepFacts(o), undefined)
    })
  }
})
