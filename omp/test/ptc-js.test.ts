import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import { ERROR_POLICIES } from '../src/kernel/errors.ts'
import type { Outcome } from '../src/kernel/outcome.ts'
import { OUTCOME_KEY, observe } from '../src/host/contracts.ts'
import { toOutcome } from '../src/ptc/outcome.ts'
import type { CanonicalData, Ops, OpsTool } from '../src/ptc/types.ts'
// `%load` rejects any module `export`, so `ops.mjs` is a script that publishes `createOps` on the
// global scope; importing it for the side effect is the closest Node analogue of that load.
import '../src/ptc/js/ops.mjs'

type AwaitTool = (tool: string, args: CanonicalData) => Promise<unknown>
type CreateOps = (awaitTool: AwaitTool) => Ops

const fileUrl = new URL('../src/ptc/js/ops.mjs', import.meta.url)

/**
 * The one name the file publishes, read exactly where the kernel reads it and then removed: the
 * kernel's global is not this test's state to leave behind.
 */
const takeCreateOps = (): CreateOps => {
  const scope = globalThis as typeof globalThis & { createOps?: CreateOps }
  try {
    assert.equal(typeof scope.createOps, 'function', 'ops.mjs must publish createOps on the global scope')
    return scope.createOps!
  } finally {
    delete scope.createOps
  }
}

const createOps = takeCreateOps()

/** The file as the loader sees it: comments stripped, because only code can break the contract. */
const SOURCE = readFileSync(fileUrl, 'utf8')
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').trim()

/** The one message the TypeScript side writes for a failure it cannot classify. */
const UNCLASSIFIED =
  'The failure carried no outcome facts, so its effects cannot be proven; inspect the raw result before any recovery.'

const OPS_TOOLS: readonly OpsTool[] = ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'eval', 'task']

interface Fixture {
  readonly name: string
  readonly tool: string
  readonly args: CanonicalData
  readonly payload: Record<string, unknown>
}

/** A recorded call, so a test can prove the exact `(name, args)` pair crossed the seam. */
interface FakeAwait {
  readonly calls: Array<readonly [string, CanonicalData]>
  readonly awaitTool: AwaitTool
}

const fakeAwait = (result: unknown): FakeAwait => {
  const calls: Array<readonly [string, CanonicalData]> = []
  const awaitTool: AwaitTool = async (tool, args) => {
    calls.push([tool, args])
    return result
  }
  return { calls, awaitTool }
}

/** The wire shape `observe` consumes, which is also what a host tool resolves with. */
const payload = (
  details: unknown,
  over: { readonly tool?: string, readonly callId?: string, readonly isError?: boolean } = {},
): Record<string, unknown> => ({
  toolName: over.tool ?? 'read',
  ...(over.callId === undefined ? {} : { toolCallId: over.callId }),
  input: { path: 'note.txt' },
  content: [{ type: 'text', text: 'ok' }],
  details,
  isError: over.isError ?? false,
})

const facts = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  status: 'completed',
  effectState: 'none',
  retry: 'never',
  message: 'done',
  ...over,
})

const withFacts = (over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...extra,
  [OUTCOME_KEY]: facts(over),
})

const fixture = (name: string, body: Record<string, unknown>, tool = 'read'): Fixture => ({
  name,
  tool,
  args: { path: 'note.txt' },
  payload: body,
})

const cyclic: Record<string, unknown> = { name: 'loop' }
cyclic.self = cyclic

const deep = (depth: number): Record<string, unknown> => {
  let node: Record<string, unknown> = { leaf: 'end' }
  for (let i = 0; i < depth; i += 1) node = { next: node }
  return node
}

const hostile = {
  keep: 1,
  get boom(): string {
    throw new Error('a getter that throws is a value we do not have')
  },
}

/**
 * Every code the kernel classifies, twice: once with a legal published retry (the producer's word
 * wins) and once with an illegal one (the frozen `errorPolicy` copy decides, status and retry
 * together — so the parity assertion pins the copy against `errorPolicy`, which the TypeScript side
 * calls for real).
 */
const CODE_FIXTURES: readonly Fixture[] = Object.keys(ERROR_POLICIES).flatMap((code) => [
  fixture(
    `published failure ${code} with a legal retry`,
    payload(withFacts({ status: 'error', code, effectState: 'none', retry: 'after-state-change', message: `failed ${code}` })),
  ),
  fixture(
    `published failure ${code} falling back to the kernel policy`,
    payload(withFacts({ status: 'error', code, effectState: 'none', retry: 'whenever', message: `failed ${code}` })),
  ),
])

const FIXTURES: readonly Fixture[] = [
  fixture('a clean result', payload({ body: 'alpha' })),
  fixture('a clean result carrying a call id', payload({ body: 'alpha' }, { callId: 'call-7' })),
  fixture('a clean result with no details at all', payload(undefined)),
  fixture('a clean result whose details are not a named object', payload('not-a-record')),
  fixture('a clean result whose details are an array', payload([1, 2])),
  fixture('an unclassified failure', payload({ stderr: 'boom' }, { isError: true })),
  // The kernel's one documented producer-side override: unknown effects, yet `after-input-change`.
  fixture('the shell exit-code override', payload(withFacts({
    status: 'unknown',
    code: 'EXIT_CODE',
    effectState: 'unknown',
    retry: 'after-input-change',
    message: 'the command exited 1',
  }))),
  fixture('an illegal published retry', payload(withFacts({
    code: 'INVALID_ARGUMENT',
    retry: 'eventually',
    message: 'bad argument',
  }))),
  fixture('a legal published retry that overrides the policy', payload(withFacts({
    code: 'INVALID_ARGUMENT',
    retry: 'bounded-transient',
    message: 'busy',
  }))),
  fixture('facts that are not an object', payload({ [OUTCOME_KEY]: 'yes' }, { isError: true })),
  fixture('facts missing the retry the contract needs', payload({
    [OUTCOME_KEY]: { status: 'error', effectState: 'none', message: 'x' },
  }, { isError: true })),
  fixture('a failure fact with no code', payload(withFacts({
    status: 'unknown',
    effectState: 'unknown',
    message: 'nobody knows',
  }))),
  fixture('a failure fact whose effect state is unrecognised', payload(withFacts({
    status: 'error',
    code: 'IO_ERROR',
    effectState: 'probably-fine',
    retry: 'never',
    message: 'disk',
  }))),
  fixture('a failure fact with a next action', payload(withFacts({
    status: 'error',
    code: 'NOT_FOUND',
    message: 'missing',
    nextAction: 'list the directory',
  }))),
  fixture('a failure fact with an empty next action', payload(withFacts({
    status: 'error',
    code: 'NOT_FOUND',
    message: 'missing',
    nextAction: '',
  }))),
  fixture('a completed fact carrying complete coverage', payload(withFacts({
    coverage: { scannedFiles: 4, matchedCount: 2, isComplete: true, truncatedBy: 'time' },
  }, { files: ['a.txt'] }))),
  fixture('a completed fact whose coverage carries no scanned count', payload(withFacts({
    coverage: { matchedCount: 2, isComplete: true },
  }))),
  fixture('a completed fact whose coverage contradicts it', payload(withFacts({
    coverage: { scannedFiles: 4, matchedCount: 2, isComplete: false, truncatedBy: 'scan-budget' },
  }))),
  fixture('a partial fact with coverage', payload(withFacts({
    status: 'partial',
    coverage: { scannedFiles: 4, matchedCount: 2, isComplete: false, truncatedBy: 'row-limit' },
  }))),
  fixture('a partial fact with no coverage', payload(withFacts({ status: 'partial' }))),
  fixture('coverage with unreadable counts and an unknown truncation cause', payload(withFacts({
    coverage: { scannedFiles: -1, matchedCount: '7', isComplete: true, truncatedBy: 'vibes' },
  }))),
  fixture('a failure that only claims completion', payload(withFacts({}, { stderr: 'boom' }), { isError: true })),
  fixture('details carrying values that have no JSON spelling', payload({
    at: 10n,
    fn: () => 1,
    sym: Symbol('s'),
    missing: undefined,
    nan: Number.NaN,
    inf: -Infinity,
    ok: 7,
  })),
  fixture('details that contain a cycle', payload(cyclic)),
  fixture('details whose property throws when read', payload(hostile)),
  fixture('details nested past the readable depth', payload({ root: deep(300) })),
  fixture('a nested facts key', payload({ outer: withFacts({ message: 'inner' }) })),
  ...CODE_FIXTURES,
]

// ---------------------------------------------------------------------------------------------
// Parity: the point of the file.
// ---------------------------------------------------------------------------------------------

for (const case_ of FIXTURES) {
  test(`parity: ${case_.name}`, async () => {
    const observation = observe(case_.payload)
    assert.notEqual(observation, undefined, `${case_.name}: the fixture is not a valid observation`)

    const fake = fakeAwait(case_.payload)
    const ops = createOps(fake.awaitTool)
    const method = ops[case_.tool as OpsTool]
    const actual = await method(case_.args)

    assert.deepEqual(actual, toOutcome(observation!))
    // The pair handed to the host is the one that was asked for, not a re-derived copy.
    assert.deepEqual(fake.calls, [[case_.tool, case_.args]])
    assert.equal(fake.calls[0]![1], case_.args)
  })
}

test('the parity table covers every case the contract names', () => {
  // A table that quietly shrinks would keep passing, so the floor is asserted rather than implied.
  assert.ok(FIXTURES.length >= 10)
  assert.equal(CODE_FIXTURES.length, Object.keys(ERROR_POLICIES).length * 2)
})

test('an unclassified failure is reported as unknown, never thrown', async () => {
  const actual = await createOps(fakeAwait(payload(undefined, { isError: true })).awaitTool).read({ path: 'x' })
  if (actual.status === 'completed' || actual.status === 'partial') {
    assert.fail(`expected a failure outcome, received ${actual.status}`)
  }
  assert.equal(actual.status, 'unknown')
  assert.equal(actual.error.code, 'RESULT_UNKNOWN')
  assert.equal(actual.error.effectState, 'unknown')
  assert.equal(actual.error.retry, 'never')
  assert.equal(actual.error.message, UNCLASSIFIED)
})

// ---------------------------------------------------------------------------------------------
// Structure: the seam that a parity table cannot see.
// ---------------------------------------------------------------------------------------------

test('the helper is a script: no imports, no requires, no exports, one published name', () => {
  // Comments may discuss the constraint; the code may not break it, so only code is inspected.
  assert.doesNotMatch(CODE, /\bimport\b/, 'ops.mjs must not import anything: the Bun worker cannot resolve it')
  assert.doesNotMatch(CODE, /\brequire\b/, 'ops.mjs must not require anything')
  // The load contract: `%load` rejects any file containing a module `export`, so one surviving
  // `export` keyword makes the helper unreachable from the kernel no matter how correct it is.
  assert.doesNotMatch(CODE, /\bexport\b/, 'ops.mjs must not export: %load cannot parse a module')
  assert.doesNotMatch(CODE, /\bimport\s*\(/, 'ops.mjs must not use a dynamic import either')
  // Removing `export` alone would leave `createOps` in the loaded chunk and nowhere else.
  assert.match(
    CODE,
    /\bglobalThis\.createOps\s*=\s*createOps\s*;?\s*$/,
    'ops.mjs must end by publishing createOps on the global scope: that assignment is the load contract',
  )
})

test('the helper parses as a script, which is the mechanical analogue of %load', () => {
  // `%load` runs a file through the same parse that `vm.Script` uses: a module declaration or an
  // import is a SyntaxError there, exactly as it was live. This cannot prove `%load` works, only
  // that the file no longer contains the construct that proved it does not.
  assert.doesNotThrow(() => new Script(SOURCE, { filename: fileUrl.pathname }))
  // The guard is only worth having if it rejects the shape that broke, so a module is refused here.
  // V8 says "Unexpected token 'export'" where Bun/`%load` said "Unexpected keyword 'export'"; the
  // message is the engine's, the rejection is the contract.
  assert.throws(() => new Script('export function createOps() {}'), /Unexpected (token|keyword) 'export'/)
  assert.throws(() => new Script("import { x } from './x.mjs'"), /Cannot use import statement|Unexpected (token|keyword) 'import'/)
})

test('createOps answers one method per tool and nothing else', async () => {
  const ops = createOps(fakeAwait(payload({})).awaitTool)
  assert.deepEqual(Object.keys(ops).sort(), [...OPS_TOOLS].sort())
  assert.equal(Object.keys(ops).length, OPS_TOOLS.length)
  for (const tool of OPS_TOOLS) {
    assert.equal(typeof ops[tool], 'function', `${tool} must be a method`)
  }
})

test('every method hands the host the exact (name, args) pair', async () => {
  for (const tool of OPS_TOOLS) {
    const fake = fakeAwait(payload({}))
    const ops = createOps(fake.awaitTool)
    const args = { path: 'note.txt', id: tool }
    const result: Outcome<CanonicalData> = await ops[tool](args)
    assert.deepEqual(fake.calls, [[tool, args]])
    assert.equal(result.status, 'completed')
  }
})

test('omitted args reach the host as an empty object, not undefined', async () => {
  const fake = fakeAwait(payload({}))
  const ops = createOps(fake.awaitTool)
  // `Ops` requires args; the prelude's JavaScript callers pass none for some tools.
  const callable = ops.bash as unknown as (args?: CanonicalData) => Promise<Outcome<CanonicalData>>
  await callable()
  assert.deepEqual(fake.calls, [['bash', {}]])
})

test('a result that is not an observation becomes unknown instead of throwing', async () => {
  const notObservations: readonly unknown[] = [undefined, null, 'text', 42, [], () => 'x', true]
  for (const result of notObservations) {
    const ops = createOps(fakeAwait(result).awaitTool)
    const actual = await ops.grep({ pattern: 'x' })
    if (actual.status === 'completed' || actual.status === 'partial') {
      assert.fail(`expected a failure outcome for ${String(result)}, received ${actual.status}`)
    }
    assert.equal(actual.status, 'unknown')
    assert.equal(actual.error.code, 'RESULT_UNKNOWN')
    assert.equal(actual.error.effectState, 'unknown')
    assert.equal(actual.error.retry, 'never')
    assert.equal(actual.error.message, UNCLASSIFIED)
    assert.deepEqual(actual.data, { tool: 'grep' })
  }
})

test('createOps refuses to build a surface with nothing to await', () => {
  assert.throws(() => createOps(undefined as unknown as AwaitTool), TypeError)
  assert.throws(() => createOps('tool' as unknown as AwaitTool), TypeError)
})
