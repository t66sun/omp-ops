import assert from 'node:assert/strict'
import { test } from 'node:test'
import { observe, type ToolObservation } from '../src/host/contracts.ts'
import {
  attachTransforms,
  registerTransform,
  registeredTransforms,
  runTransforms,
  transformFailures,
  type FeatureFlag,
  type MutableResult,
  type Transform,
} from '../src/pipeline.ts'

const observation = (): ToolObservation => ({
  tool: 'read',
  args: { path: 'a.txt' },
  content: [{ type: 'text', text: 'body' }],
  details: { bytes: 4 },
  isError: false,
})

const result = (): MutableResult => ({
  content: [{ type: 'text', text: 'body' }],
  details: { bytes: 4 },
  isError: false,
})

const transform = (name: string, features: readonly FeatureFlag[], apply: Transform['apply']): Transform => ({
  name,
  features,
  apply,
})

test('runs transforms in registration order and skips unrelated features', () => {
  const calls: string[] = []
  registerTransform(transform('order/first', ['honesty'], () => void calls.push('first')))
  registerTransform(transform('order/second', ['ptc'], () => void calls.push('second')))
  registerTransform(transform('order/third', ['honesty'], () => void calls.push('third')))

  assert.deepEqual(
    registeredTransforms().map((t) => t.name),
    ['order/first', 'order/second', 'order/third'],
  )

  const out = result()
  runTransforms(observation(), out, ['honesty'])
  assert.deepEqual(calls, ['first', 'third'])
  assert.deepEqual(out, result())
})

test('a throwing transform is recorded and does not stop later transforms', () => {
  const calls: string[] = []
  registerTransform(
    transform('order/boom', ['honesty'], () => {
      throw new Error('boom')
    }),
  )
  registerTransform(transform('order/after', ['honesty'], () => void calls.push('after')))

  const out = result()
  runTransforms(observation(), out, ['honesty'])
  runTransforms(observation(), out, ['honesty'])

  assert.deepEqual(calls, ['after', 'after'])
  assert.deepEqual(
    transformFailures().filter((name) => name === 'order/boom'),
    ['order/boom'],
  )
  assert.deepEqual(out, result())
})

test('registering the same name twice throws', () => {
  assert.throws(
    () => registerTransform(transform('order/first', ['honesty'], () => {})),
    /duplicate transform: order\/first/,
  )
})

test('observe returns undefined for shapes it does not recognise', () => {
  assert.equal(observe(null), undefined)
  assert.equal(observe(undefined), undefined)
  assert.equal(observe({}), undefined)
  assert.equal(observe({ toolName: 'read', content: 'text', isError: false }), undefined)
  assert.equal(observe({ toolName: 7, content: [], isError: false }), undefined)
  assert.equal(observe({ toolName: 'read', content: [], isError: 'no' }), undefined)
})

test('observe maps the host payload onto our field names and freezes the copy', () => {
  const raw = {
    type: 'tool_result',
    toolName: 'read',
    toolCallId: 'call_00_probe',
    input: { path: 'a.txt' },
    content: [{ type: 'text', text: 'body' }],
    details: { totalLines: 9 },
    isError: false,
  }
  const o = observe(raw)
  assert.notEqual(o, undefined)
  assert.deepEqual({ ...o }, {
    tool: 'read',
    args: { path: 'a.txt' },
    content: [{ type: 'text', text: 'body' }],
    details: { totalLines: 9 },
    isError: false,
    callId: 'call_00_probe',
  })
  assert.equal(Object.isFrozen(o), true)
  assert.equal(Object.isFrozen(o?.content), true)

  raw.content.push({ type: 'text', text: 'extra' })
  assert.equal(o?.content.length, 1)
})

test('a payload without a call id observes as undefined callId rather than an empty string', () => {
  const base = { type: 'tool_result', toolName: 'read', input: {}, content: [], details: {}, isError: false }
  assert.equal(observe(base)?.callId, undefined)
  assert.equal(observe({ ...base, toolCallId: '' })?.callId, undefined, 'an empty id names nothing')
})

const OWED = new Set(['rules/bash', 'rules/file', 'rules/search', 'rules/eval', 'honesty/render', 'dedup/read'])

test('the entry registers every rule, then the renderer, then the dedup coordinator', async () => {
  const { registeredTransforms } = await import('../src/pipeline.ts')
  await import('../src/extension/index.ts')
  assert.deepEqual(
    registeredTransforms().map((t) => t.name).filter((n) => OWED.has(n)),
    ['rules/bash', 'rules/file', 'rules/search', 'rules/eval', 'honesty/render', 'dedup/read'],
  )
  const out = { content: [{ type: 'text', text: 'untouched' }], details: { totalLines: 1 }, isError: false }
  const snapshot = JSON.stringify(out)
  for (const t of registeredTransforms()) {
    if (!OWED.has(t.name)) continue
    t.apply({ tool: 'read', args: {}, content: [], details: {}, isError: false }, out)
  }
  assert.equal(JSON.stringify(out), snapshot, 'no transform may act on an observation that carries no facts')
})

test('the host context reaches every transform that asks for it', () => {
  const seen: unknown[] = []
  registerTransform({
    name: 'ctx/probe',
    features: ['honesty'],
    apply(_o, _out, ctx) {
      seen.push(ctx)
    },
  })
  const ctx = { agent: { id: 'a1' } }
  runTransforms(
    { tool: 'read', args: {}, content: [], details: {}, isError: false },
    { content: [], details: {}, isError: false },
    ['honesty'],
    ctx,
  )
  assert.equal(seen.length, 1, 'apply must receive the context')
  assert.equal(seen[0], ctx, 'the same object must arrive, not a copy')
})

test('attach runs once per transform and a throwing attach is recorded, not fatal', () => {
  let attached = 0
  const host = { on() {} }
  registerTransform({ name: 'attach/good', features: ['honesty'], apply() {}, attach: () => { attached += 1 } })
  registerTransform({
    name: 'attach/bad',
    features: ['honesty'],
    apply() {},
    attach() {
      throw new Error('boom')
    },
  })
  attachTransforms(host)
  assert.equal(attached, 1, 'attach must be called exactly once')
  // One call per feature entry: the base entry runs before any feature module is imported, so repeated
  // calls are the normal path and the set must keep a transform from observing the session twice.
  attachTransforms(host)
  attachTransforms(host)
  assert.equal(attached, 1, 'a repeated call must not re-attach')
  assert.ok(transformFailures().includes('attach/bad'), 'a throwing attach must be recorded')
  assert.ok(!transformFailures().includes('attach/good'))
})
