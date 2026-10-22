import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { OUTCOME_KEY, observe } from '../src/host/contracts.ts'
import { toOutcome } from '../src/ptc/outcome.ts'

const OPS_PATH = fileURLToPath(new URL('../src/ptc/py/ops.py', import.meta.url))

const TOOLS = ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'eval', 'task'] as const

/** Modules a projection may use. It has none today; the allowlist is the standard library. */
const STDLIB: Readonly<Record<string, true>> = {
  abc: true, argparse: true, array: true, asyncio: true, base64: true, collections: true,
  contextlib: true, copy: true, dataclasses: true, datetime: true, decimal: true, enum: true,
  functools: true, hashlib: true, io: true, itertools: true, json: true, math: true,
  operator: true, os: true, pathlib: true, re: true, stat: true, string: true, struct: true,
  sys: true, tempfile: true, types: true, typing: true, uuid: true, warnings: true,
}

interface Fixture {
  readonly tool: string
  readonly args: Record<string, unknown>
  readonly payload: Record<string, unknown>
}

const payload = (tool: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  toolName: tool,
  input: { path: 'note.txt' },
  content: [],
  isError: false,
  ...over,
})

/** The shape a rule publishes: details plus the facts envelope under `outcome.v1`. */
const withFacts = (
  facts: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  ...extra,
  [OUTCOME_KEY]: { status: 'completed', effectState: 'none', retry: 'never', message: 'done', ...facts },
})

const fixture = (
  tool: string,
  over: Record<string, unknown>,
  args: Record<string, unknown> = { path: 'note.txt' },
): Fixture => ({ tool, args, payload: payload(tool, over) })

/**
 * The one fixture set both languages read. Each payload is a host `tool_result`, so TypeScript
 * exercises `observe` + `toOutcome` and Python exercises `create_ops` + the projection underneath
 * it: the same bytes on both sides, with no second copy to drift.
 */
const FIXTURES: readonly Fixture[] = [
  // A clean observation: no facts, no coverage claim, identity only.
  fixture('read', { details: { body: 'alpha' } }),

  // A completed fact with full coverage, a truncation cause and a call identity.
  fixture('grep', {
    toolCallId: 'call-7',
    details: withFacts({ coverage: { scannedFiles: 4, matchedCount: 2, isComplete: true } }, { files: ['a.txt'] }),
  }),

  // `time` is the search report's spelling of the time budget; the kernel spelling is `time-limit`.
  fixture('read', {
    details: withFacts({ coverage: { scannedFiles: 1, matchedCount: 0, isComplete: true, truncatedBy: 'time' } }),
  }),

  // Coverage fields the kernel cannot read are sanitised, not passed through.
  fixture('grep', {
    details: withFacts({
      coverage: { scannedFiles: 'many', matchedCount: -2, isComplete: true, truncatedBy: 'made-up' },
    }),
  }),

  // `1` is not a completeness claim: strict `true` only, so the fact falls to the incomplete path.
  fixture('grep', {
    details: withFacts({ coverage: { scannedFiles: 3, matchedCount: 3, isComplete: 1 } }, { files: [] }),
  }),

  // A completed fact contradicted by incomplete coverage downgrades to `RESULT_PARTIAL`.
  fixture('read', {
    details: withFacts({ coverage: { scannedFiles: 2, matchedCount: 1, isComplete: false, truncatedBy: 'row-limit' } }),
  }),

  // A partial fact never yields an invented continuation, with or without coverage.
  fixture('grep', {
    details: withFacts({
      status: 'partial',
      coverage: { scannedFiles: 9, matchedCount: 4, isComplete: false, truncatedBy: 'scan-budget' },
    }),
  }),
  fixture('read', { details: withFacts({ status: 'partial' }) }),

  // The kernel's one documented producer-side retry override survives.
  fixture('bash', {
    isError: true,
    details: withFacts({
      status: 'error', code: 'EXIT_CODE', effectState: 'unknown', retry: 'after-input-change', message: 'exit 3',
    }),
  }),

  // A published retry that is not one of the four legal advices is not advice: the policy answers.
  fixture('bash', {
    isError: true,
    details: withFacts({
      status: 'error', code: 'EXIT_CODE', effectState: 'unknown', retry: 'sure-go-ahead', message: 'exit 3',
    }),
  }),

  // A settled failure keeps its applied effect state and its next action.
  fixture('write', {
    isError: true,
    details: withFacts({
      status: 'error',
      code: 'IO_ERROR',
      effectState: 'applied',
      retry: 'never',
      message: 'write failed after the rename',
      nextAction: 'inspect the target',
    }),
  }),

  // An unreadable effect state is treated as unknown, never as harmless.
  fixture('read', {
    isError: true,
    details: withFacts({ status: 'error', code: 'IO_ERROR', effectState: 'probably-fine' }),
  }),

  // A failure fact with no readable code is unknown, not the status it claimed.
  fixture('read', { isError: true, details: withFacts({ status: 'rejected' }) }),

  // A rejected fact keeps its policy-derived pair.
  fixture('read', { isError: true, details: withFacts({ status: 'rejected', code: 'POLICY_DENIED' }) }),

  // Effects dominate a code that would otherwise advise an input change.
  fixture('read', {
    isError: true,
    details: withFacts({ status: 'error', code: 'RESULT_UNKNOWN', effectState: 'applied' }),
  }),

  // Facts make a success even when the host flagged an error.
  fixture('glob', {
    isError: true,
    details: withFacts({ coverage: { scannedFiles: 5, matchedCount: 5, isComplete: true } }),
  }),

  // Details that are not a named object leave only the identity.
  fixture('read', { details: 'not a graph' }),
  fixture('read', { details: [1, 2, 'x'] }),

  // An `isError` with no facts at all claims unknown effects and forbids retrying.
  fixture('glob', { isError: true }),

  // An empty callId is not published; the observation owns the identity, not the payload.
  fixture('read', { toolCallId: '', details: { body: 'alpha' } }),

  // The raw facts envelope is not duplicated inside data, at any depth.
  fixture('read', {
    details: withFacts({}, { body: 'alpha', nested: { [OUTCOME_KEY]: { status: 'error', message: 'inner' }, keep: 1 } }),
  }),

  // A conflict keeps its code and the advice its status implies.
  fixture('task', { isError: true, details: withFacts({ status: 'conflict', code: 'REVISION_CONFLICT' }) }),

  // Empty coverage is not completeness: the weaker claim is the true one.
  fixture('grep', { details: withFacts({ coverage: {} }) }),

  // Coverage that is not a named object carries no counts at all, so it is not a coverage claim.
  fixture('grep', { details: withFacts({ coverage: [true, 4] }) }),

  // An empty effect state is unreadable, and an empty code is no code: both fall back to unknown.
  fixture('read', { isError: true, details: withFacts({ status: 'error', code: '', effectState: '' }) }),

  // An empty next action is not an action, and the legal published retry still applies.
  fixture('bash', {
    isError: true,
    details: withFacts({
      status: 'error', code: 'EXIT_CODE', effectState: 'unknown', retry: 'after-input-change', nextAction: '',
    }),
  }),

  // A facts envelope that is not a named object is no facts at all.
  fixture('read', { isError: true, details: { [OUTCOME_KEY]: 'not facts' } }),
]

const PARSE_ONLY = [
  'import ast, sys',
  'with open(sys.argv[1], encoding="utf-8") as handle:',
  '    ast.parse(handle.read(), sys.argv[1])',
].join('\n')

const DRIVER = [
  'import importlib.util, json, sys',
  '',
  'ops_path, fixtures_path = sys.argv[1], sys.argv[2]',
  "spec = importlib.util.spec_from_file_location('ptc_ops_under_test', ops_path)",
  'module = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(module)',
  '',
  "with open(fixtures_path, encoding='utf-8') as handle:",
  '    fixtures = json.load(handle)',
  '',
  'pending = list(fixtures)',
  '',
  'def bridge(name, args):',
  '    fixture = pending.pop(0)',
  "    payload = fixture['payload']",
  "    if payload.get('toolName') != name:",
  "        raise AssertionError('ops called %r but the fixture is %r' % (name, payload.get('toolName')))",
  "    if args != fixture['args']:",
  "        raise AssertionError('ops forwarded %r but the fixture asked for %r' % (args, fixture['args']))",
  '    return payload',
  '',
  'ops = module.create_ops(bridge)',
  "methods = sorted(name for name in dir(ops) if not name.startswith('_') and callable(getattr(ops, name)))",
  'results = [getattr(ops, item["tool"])(item["args"]) for item in fixtures]',
  "json.dump({'methods': methods, 'results': results}, sys.stdout)",
].join('\n')

interface Interpreter {
  readonly command: string
  readonly version: string
}

function run(command: string, args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(command, [...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000 })
}

/** Locates an interpreter in the documented order: `python`, then `python3`, then `py`. */
function findInterpreter(): Interpreter | undefined {
  for (const command of ['python', 'python3', 'py']) {
    const probe = run(command, ['--version'])
    if (probe.status === 0) return { command, version: `${probe.stdout}${probe.stderr}`.trim() }
  }
  return undefined
}

const INTERPRETER = findInterpreter()

test('ops.py is a standard-library-only projection with one method per tool and the JS field spelling', () => {
  const text = readFileSync(OPS_PATH, 'utf8')
  assert.ok(text.split('\n').length <= 1000, 'ops.py must stay within the file-size limit')

  // No third-party import: every imported module root is in the standard library, and none of them
  // is ours (the host bridge is handed in, never imported).
  for (const match of text.matchAll(/^[ \t]*(?:from[ \t]+([A-Za-z_][\w.]*)[ \t]+import|import[ \t]+([A-Za-z_][\w.]*))/gm)) {
    const root = (match[1] ?? match[2] ?? '').split('.')[0]!
    assert.ok(Object.hasOwn(STDLIB, root), `ops.py imports a module outside the standard library: ${root}`)
  }
  assert.doesNotMatch(text, /^[ \t]*(?:from|import)[ \t]+(?:omp|dsh|cordis)\b/m, 'ops.py must not import the host')

  // Exactly one method per tool, each taking the request's arguments and nothing else.
  const methods = [...text.matchAll(/^[ \t]*def[ \t]+([A-Za-z_]\w*)[ \t]*\([ \t]*self[ \t]*,[ \t]*args[ \t]*\)/gm)]
    .map((match) => match[1]!)
  assert.deepEqual([...new Set(methods)].sort(), [...TOOLS].sort(), 'one method per tool, no more, no fewer')

  // The camelCase field names are the contract; a snake_cased key would make a model relearn it.
  for (const field of ['status', 'error', 'data', 'coverage', 'continuation', 'code', 'message', 'retry', 'effectState', 'nextAction']) {
    assert.match(text, new RegExp(`['"]${field}['"]`), `ops.py never produces the ${field} field`)
  }
  assert.doesNotMatch(text, /['"](?:effect_state|next_action|is_complete|matched_count|scanned_files)['"]/,
    'a snake_case field name would break parity with the JS helper')
  assert.match(text, /OUTCOME_KEY = 'outcome\.v1'/, 'the facts key is part of the contract')
})

test('ops.py parses under an interpreter', (t) => {
  if (INTERPRETER === undefined) {
    t.skip('no python interpreter found (python, python3, py); the static contract assertions above still ran')
    return
  }
  const parsed = run(INTERPRETER.command, ['-c', PARSE_ONLY, OPS_PATH])
  assert.equal(parsed.status, 0, `ops.py did not parse: ${parsed.stderr || parsed.stdout}`)
})

test('the Python projection answers exactly what toOutcome answers, fixture for fixture', (t) => {
  if (INTERPRETER === undefined) {
    t.skip('no python interpreter found (python, python3, py); the static contract assertions above still ran')
    return
  }
  assert.ok(FIXTURES.length >= 10, `the parity set needs at least ten fixtures, has ${FIXTURES.length}`)

  // Prove the file is syntactically valid before importing it, so a broken file reports itself as a
  // syntax error instead of hiding behind whatever the import happens to raise first.
  const parsed = run(INTERPRETER.command, ['-c', PARSE_ONLY, OPS_PATH])
  assert.equal(parsed.status, 0, `ops.py did not parse: ${parsed.stderr || parsed.stdout}`)

  const expected = FIXTURES.map((item) => {
    const observation = observe(item.payload)
    assert.ok(observation, `fixture ${item.tool} is not a host tool_result`)
    return toOutcome(observation)
  })
  // Both sides must agree on JSON, not on object identity: the Python side can only answer JSON.
  const expectedJson: unknown = JSON.parse(JSON.stringify(expected))

  const directory = mkdtempSync(join(tmpdir(), 'omp-ptc-py-'))
  try {
    const fixturesPath = join(directory, 'fixtures.json')
    writeFileSync(fixturesPath, JSON.stringify(FIXTURES), 'utf8')
    const driven = run(INTERPRETER.command, ['-c', DRIVER, OPS_PATH, fixturesPath])
    assert.equal(driven.status, 0, `the Python projection failed: ${driven.stderr || driven.stdout}`)

    const actual = JSON.parse(driven.stdout) as { methods: string[], results: unknown[] }
    assert.deepEqual([...actual.methods].sort(), [...TOOLS].sort(), 'one public method per tool')
    assert.equal(actual.results.length, FIXTURES.length, 'every fixture must produce one outcome')
    assert.deepEqual(actual.results, expectedJson, `Python and TypeScript disagree under ${INTERPRETER.version}`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
