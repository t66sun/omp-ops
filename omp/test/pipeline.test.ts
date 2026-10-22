import assert from 'node:assert/strict'
import { test } from 'node:test'
import { observe, type ToolObservation } from '../src/host/contracts.ts'
import {
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
  })
  assert.equal(Object.isFrozen(o), true)
  assert.equal(Object.isFrozen(o?.content), true)

  raw.content.push({ type: 'text', text: 'extra' })
  assert.equal(o?.content.length, 1)
})

test('the real barrels register the rules then the renderer, in that order', async () => {
  const { registeredTransforms } = await import('../src/pipeline.ts')
  await import('../src/extension/index.ts')
  const owned = new Set(['rules/bash', 'rules/file', 'rules/search', 'rules/eval', 'honesty/render', 'dedup/read'])
  assert.deepEqual(
    registeredTransforms().map((t) => t.name).filter((n) => owned.has(n)),
    ['rules/bash', 'rules/file', 'rules/search', 'rules/eval', 'honesty/render', 'dedup/read'],
  )
  const out = { content: [{ type: 'text', text: 'untouched' }], details: { totalLines: 1 }, isError: false }
  const snapshot = JSON.stringify(out)
  for (const t of registeredTransforms()) {
    if (!owned.has(t.name)) continue
    t.apply({ tool: 'read', args: {}, content: [], details: {}, isError: false }, out)
  }
  assert.equal(JSON.stringify(out), snapshot, 'every Round 0 transform must be inert')
})
