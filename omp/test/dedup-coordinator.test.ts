import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { ToolObservation } from '../src/host/contracts.ts'
import type { MutableResult, Transform, TransformContext } from '../src/pipeline.ts'
import type { DedupTarget } from '../src/dedup/types.ts'
import { createDedup } from '../src/dedup/coordinator.ts'

/**
 * 30 numbered lines, 200 bytes. The reference line for a short call id is ~152 bytes, so a rewrite
 * of this body is strictly shorter by a comfortable margin and the size assertion is not a
 * coincidence of one id.
 */
const BODY = Array.from({ length: 30 }, (_, i) => `${i + 1} | x`).join('\n')
const OTHER_BODY = Array.from({ length: 30 }, (_, i) => `${i + 1} | y`).join('\n')

const REFERENCE = (callId: string): string =>
  `[Notice: Unchanged file range; body already present in the current model context in tool call ${JSON.stringify(callId)}. Fresh read revalidated the revision above.]`

let root: string
let fileA: string
let fileB: string
let savedSession: string | undefined

const TEST_SESSION = 'session-coordinator-test'

before(() => {
  root = mkdtempSync(join(tmpdir(), 'omp-dedup-coordinator-'))
  fileA = join(root, 'a.txt')
  fileB = join(root, 'b.txt')
  writeFileSync(fileA, BODY)
  writeFileSync(fileB, OTHER_BODY)
  savedSession = process.env.PI_SESSION_ID
  process.env.PI_SESSION_ID = TEST_SESSION
})

after(() => {
  if (savedSession === undefined) delete process.env.PI_SESSION_ID
  else process.env.PI_SESSION_ID = savedSession
  rmSync(root, { recursive: true, force: true })
})

const detailsOf = (path: string): unknown => ({ meta: { source: { type: 'path', value: path } } })

const readObservation = (callId: string, path: string = fileA, body: string = BODY): ToolObservation => ({
  tool: 'read',
  args: { path },
  content: [{ type: 'text', text: body }],
  details: detailsOf(path),
  isError: false,
  callId,
})

const resultOf = (o: ToolObservation): MutableResult => ({
  content: [...o.content],
  details: o.details,
  isError: o.isError,
})

const textOf = (out: MutableResult): string => {
  assert.equal(out.content.length, 1, 'expected exactly one content block')
  const block = out.content[0]
  assert.ok(
    typeof block === 'object' && block !== null && 'text' in block && typeof block.text === 'string',
    'expected one text block',
  )
  return block.text
}

/** Applies one observation and returns the mutated result plus the text the model would see. */
const run = (
  dedup: Transform,
  o: ToolObservation,
  ctx?: TransformContext,
): { out: MutableResult; text: string } => {
  const out = resultOf(o)
  dedup.apply(o, out, ctx)
  return { out, text: textOf(out) }
}

/** A host stub that records the handlers it was given, the way the extension API is used. */
const hostStub = (): { host: unknown; handlers: Map<string, () => void> } => {
  const handlers = new Map<string, () => void>()
  const host = {
    on(event: string, handler: () => void): void {
      handlers.set(event, handler)
    },
  }
  return { host, handlers }
}

test('the transform is the dedup/read transform and owns both hooks', () => {
  const dedup = createDedup()
  assert.equal(dedup.name, 'dedup/read')
  assert.deepEqual(dedup.features, ['dedup'])
  assert.equal(typeof dedup.apply, 'function')
  assert.equal(typeof dedup.attach, 'function')
})

test('the first read is stored and left byte-identical; the identical second read collapses to one reference', () => {
  const dedup = createDedup()

  const first = readObservation('call-read-1')
  const firstOut = resultOf(first)
  dedup.apply(first, firstOut)
  assert.deepEqual(firstOut.content, first.content, 'a first read is never rewritten')
  assert.equal(firstOut.content[0], first.content[0], 'the block object itself is not replaced')
  assert.equal(textOf(firstOut), BODY)
  assert.equal(Buffer.byteLength(textOf(firstOut), 'utf8'), 200)

  const second = readObservation('call-read-2')
  const before = JSON.stringify(second.details)
  const { out, text } = run(dedup, second)

  assert.equal(out.content.length, 1, 'the single block is replaced, never appended to')
  assert.equal(text, REFERENCE('call-read-1'), 'the reference names the call that carries the body')
  assert.ok(
    Buffer.byteLength(text, 'utf8') < Buffer.byteLength(BODY, 'utf8'),
    'the rewrite must be strictly shorter than the body it replaces',
  )
  assert.equal(out.details, second.details, 'details travels by reference')
  assert.equal(JSON.stringify(out.details), before, 'the rewrite writes nothing into details')
  assert.equal(out.isError, false, 'a rewrite never flips isError')
})

test('a rewrite leaves an untouched details record alone, including the outcome key', () => {
  const dedup = createDedup()
  run(dedup, readObservation('call-details-1'))

  const second = readObservation('call-details-2')
  const details: unknown = second.details
  const { out } = run(dedup, second)

  assert.equal(out.details, details)
  assert.ok(typeof details === 'object' && details !== null)
  assert.equal(Object.hasOwn(details, 'outcome.v1'), false, 'the coordinator never publishes rules facts')
})

test('a successful mutating call forgets every record, so the next read is verbatim again', () => {
  const dedup = createDedup()
  run(dedup, readObservation('call-mutate-1'))
  assert.equal(run(dedup, readObservation('call-mutate-2')).text, REFERENCE('call-mutate-1'))

  const edit: ToolObservation = {
    tool: 'edit',
    args: { path: fileA },
    content: [{ type: 'text', text: 'edited' }],
    details: { resolvedPath: fileA },
    isError: false,
    callId: 'call-edit-1',
  }
  const editOut = resultOf(edit)
  dedup.apply(edit, editOut)
  assert.deepEqual(editOut.content, edit.content, 'a non-dedupable result keeps its body')

  const third = readObservation('call-mutate-3')
  assert.equal(run(dedup, third).text, BODY, 'the forgotten body must not be referenced')
  assert.equal(
    run(dedup, readObservation('call-mutate-4')).text,
    REFERENCE('call-mutate-3'),
    'the third read is stored again, proving the verbatim body came from the forget',
  )
})

test('a failed mutating call keeps the records, as specified: only success invalidates', () => {
  const dedup = createDedup()
  run(dedup, readObservation('call-failed-1'))

  const failedEdit: ToolObservation = {
    tool: 'edit',
    args: { path: fileA },
    content: [{ type: 'text', text: 'old_string not found' }],
    details: {},
    isError: true,
    callId: 'call-edit-failed',
  }
  dedup.apply(failedEdit, resultOf(failedEdit))

  assert.equal(run(dedup, readObservation('call-failed-2')).text, REFERENCE('call-failed-1'))
})

test('a successful bash forgets, and a non-dedupable non-mutating tool is ignored entirely', () => {
  const dedup = createDedup()
  run(dedup, readObservation('call-tools-1'))

  const glob: ToolObservation = {
    tool: 'glob',
    args: { pattern: '*.txt' },
    content: [{ type: 'text', text: 'a.txt\nb.txt' }],
    details: { fileCount: 2 },
    isError: false,
    callId: 'call-glob-1',
  }
  const globOut = resultOf(glob)
  dedup.apply(glob, globOut)
  assert.deepEqual(globOut.content, glob.content, 'glob content is untouched')
  assert.equal(
    run(dedup, readObservation('call-tools-2')).text,
    REFERENCE('call-tools-1'),
    'a non-mutating non-target leaves the record usable',
  )

  const bash: ToolObservation = {
    tool: 'bash',
    args: { command: 'touch a.txt' },
    content: [{ type: 'text', text: '' }],
    details: { exitCode: 0 },
    isError: false,
    callId: 'call-bash-1',
  }
  const bashOut = resultOf(bash)
  dedup.apply(bash, bashOut)
  assert.deepEqual(bashOut.content, bash.content, 'bash content is never rewritten')
  assert.equal(run(dedup, readObservation('call-tools-3')).text, BODY, 'bash invalidated the records')
})

test('every context-rewriting event bumps the epoch and makes the next read unrewritable', () => {
  const dedup = createDedup()
  const { host, handlers } = hostStub()
  dedup.attach?.(host)

  assert.deepEqual(
    [...handlers.keys()].sort(),
    ['session_before_branch', 'session_before_compact', 'session_before_switch', 'session_compact'],
  )

  let n = 0
  for (const event of handlers.keys()) {
    const bump = handlers.get(event)
    assert.ok(bump, `no handler for ${event}`)

    // Start each round on a clean epoch, so the outcome cannot depend on the previous round.
    bump()
    n += 1
    assert.equal(run(dedup, readObservation(`call-epoch-${n}`)).text, BODY, 'a read on a fresh epoch is verbatim')

    bump()
    n += 1
    const afterBump = `call-epoch-${n}`
    assert.equal(
      run(dedup, readObservation(afterBump)).text,
      BODY,
      `${event} must withdraw the presence proof: the body is sent verbatim in full`,
    )

    n += 1
    assert.equal(
      run(dedup, readObservation(`call-epoch-${n}`)).text,
      REFERENCE(afterBump),
      'the read after the bump is stored under the new epoch and can be referenced',
    )
  }
})

test('with no resolvable agent key nothing is stored and nothing is rewritten', () => {
  const saved = process.env.PI_SESSION_ID
  delete process.env.PI_SESSION_ID
  try {
    const dedup = createDedup()
    assert.equal(run(dedup, readObservation('call-anon-1')).text, BODY)
    assert.equal(run(dedup, readObservation('call-anon-2')).text, BODY, 'no identity means no record')
    assert.equal(run(dedup, readObservation('call-anon-3'), { agent: { id: '' } }).text, BODY)
    assert.equal(run(dedup, readObservation('call-anon-4'), { agent: { id: 7 } }).text, BODY)
    assert.equal(run(dedup, readObservation('call-anon-5'), { agent: 'not-an-object' }).text, BODY)

    process.env.PI_SESSION_ID = TEST_SESSION
    assert.equal(run(dedup, readObservation('call-anon-6')).text, BODY, 'the first keyed read stores')
    assert.equal(
      run(dedup, readObservation('call-anon-7')).text,
      REFERENCE('call-anon-6'),
      'the same transform works once an identity exists, so the verbatim results above were the missing key',
    )
  } finally {
    if (saved === undefined) delete process.env.PI_SESSION_ID
    else process.env.PI_SESSION_ID = saved
  }
})

test('a ctx agent id wins over the session env var and keeps agents apart', () => {
  const dedup = createDedup()

  assert.equal(run(dedup, readObservation('call-agent-1'), { agent: { id: 'agent-1' } }).text, BODY)
  assert.equal(
    run(dedup, readObservation('call-agent-2'), { agent: { id: 'agent-2' } }).text,
    BODY,
    'a body read by one agent is not in another agent context',
  )
  assert.equal(
    run(dedup, readObservation('call-agent-3'), { agent: { id: 'agent-1' } }).text,
    REFERENCE('call-agent-1'),
  )
  assert.equal(
    run(dedup, readObservation('call-agent-4')).text,
    BODY,
    'the session key is a different agent key than agent:agent-1',
  )
})

test('an agent exposed through a prototype getter is found even though it is not an own key', () => {
  const dedup = createDedup()
  const ctx: TransformContext = Object.create({ agent: { id: 'proto-agent' } })
  assert.deepEqual(Object.keys(ctx), [], 'the getter is on the prototype, so own keys are empty')

  assert.equal(run(dedup, readObservation('call-proto-1'), ctx).text, BODY)
  assert.equal(run(dedup, readObservation('call-proto-2'), ctx).text, REFERENCE('call-proto-1'))
})

test('two different files never collide', () => {
  const dedup = createDedup()

  assert.equal(run(dedup, readObservation('call-a-1', fileA, BODY)).text, BODY)
  assert.equal(run(dedup, readObservation('call-b-1', fileB, OTHER_BODY)).text, OTHER_BODY, 'b.txt is new')

  const againA = run(dedup, readObservation('call-a-2', fileA, BODY)).text
  const againB = run(dedup, readObservation('call-b-2', fileB, OTHER_BODY)).text

  assert.equal(againA, REFERENCE('call-a-1'))
  assert.equal(againB, REFERENCE('call-b-1'))
  assert.notEqual(againA, againB)
})

test('a file rewritten on disk is sent in full instead of being referenced', () => {
  const path = join(root, 'changing.txt')
  const original = Array.from({ length: 30 }, (_, i) => `${i + 1} | o`).join('\n')
  const changed = Array.from({ length: 30 }, (_, i) => `${i + 1} | changed`).join('\n')
  writeFileSync(path, original)

  const dedup = createDedup()
  assert.equal(run(dedup, readObservation('call-change-1', path, original)).text, original)

  writeFileSync(path, changed)
  assert.equal(
    run(dedup, readObservation('call-change-2', path, changed)).text,
    changed,
    'a changed inode/mtime must not be answered with a reference to the old body',
  )
  assert.equal(run(dedup, readObservation('call-change-3', path, changed)).text, REFERENCE('call-change-2'))
})

test('a throwing target or a hostile ctx cannot break a tool result', () => {
  const boom: DedupTarget = {
    name: 'boom',
    extract() {
      throw new Error('boom')
    },
  }
  const dedup = createDedup([boom])
  const o = readObservation('call-boom-1')
  const out = resultOf(o)
  assert.doesNotThrow(() => dedup.apply(o, out))
  assert.deepEqual(out.content, o.content)
  assert.equal(out.details, o.details)

  const hostile: TransformContext = {}
  Object.defineProperty(hostile, 'agent', {
    get() {
      throw new Error('hostile ctx')
    },
  })
  const real = createDedup()
  const observation = readObservation('call-boom-2')
  assert.doesNotThrow(() => real.apply(observation, resultOf(observation), hostile))
})

test('an empty target list dedups nothing, and attach tolerates a host without on', () => {
  const dedup = createDedup([])
  assert.equal(run(dedup, readObservation('call-empty-1')).text, BODY)
  assert.equal(run(dedup, readObservation('call-empty-2')).text, BODY)

  const bare = createDedup()
  assert.doesNotThrow(() => bare.attach?.(undefined))
  assert.doesNotThrow(() => bare.attach?.({}))
  assert.doesNotThrow(() => bare.attach?.({ on: 'not a function' }))
})
