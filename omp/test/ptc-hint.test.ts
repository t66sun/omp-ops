import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ToolObservation } from '../src/host/contracts.ts'
import { createHint, OPS_JS_PATH, OPS_PY_PATH } from '../src/ptc/hint.ts'
import { attachOps, resetOpsAttachment } from '../src/ptc/install.ts'
import { registeredTransforms, runTransforms, type MutableResult } from '../src/pipeline.ts'

const HOST = { registerTool: () => undefined, on: () => undefined }

const observe = (over: Partial<ToolObservation> = {}): ToolObservation => ({
  tool: 'eval',
  args: { language: 'py', code: 'await ops.read({ path: "x" })' },
  content: [{ type: 'text', text: '' }],
  details: { language: 'py', cells: [] },
  isError: true,
  ...over,
})

const body = (text: string): ToolObservation =>
  observe({ content: [{ type: 'text', text }] })

const run = (o: ToolObservation): string[] => {
  const out: MutableResult = { content: [...o.content], details: o.details, isError: o.isError }
  createHint().apply(o, out)
  return out.content.map((block) => (typeof block === 'object' && block !== null && 'text' in block ? String(block.text) : ''))
}

test('a Python NameError for ops gets the load line, naming both runtimes', () => {
  const [text] = run(body("NameError: name 'ops' is not defined"))
  assert.ok(text !== undefined)
  assert.ok(text.includes(`%load "${OPS_JS_PATH}"`), text)
  assert.ok(text.includes('%load "'), text)
  assert.ok(text.includes(OPS_PY_PATH), text)
})

test('a JavaScript ReferenceError for createOps gets it too', () => {
  const [text] = run(body('ReferenceError: createOps is not defined\n    at <parse>'))
  assert.ok(text !== undefined && text.includes(`${OPS_JS_PATH}"`), text)
})

test('a cell that already loaded the helper is never nagged', () => {
  const [text] = run(body(`%load "${OPS_JS_PATH}"\nNameError: name 'ops' is not defined`))
  assert.equal(text, `%load "${OPS_JS_PATH}"\nNameError: name 'ops' is not defined`)
})

test('an undefined name that is not the SDK gets no line', () => {
  for (const text of ["NameError: name 'total' is not defined", 'ReferenceError: helper is not defined']) {
    assert.equal(run(body(text))[0], text, text)
  }
})

test('the line needs a failure, an eval cell, and a text block to land on', () => {
  const ready = "NameError: name 'ops' is not defined"
  assert.equal(run(observe({ content: [{ type: 'text', text: ready }], isError: false }))[0], ready)
  assert.equal(run(observe({ tool: 'bash', content: [{ type: 'text', text: ready }] }))[0], ready)
  const image = observe({ content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] })
  assert.deepEqual(run(image), [''])
})

test('the line is appended to the last block, leaving earlier blocks untouched', () => {
  const o = observe({
    content: [{ type: 'text', text: 'first' }, { type: 'text', text: "NameError: name 'ops' is not defined" }],
  })
  const out: MutableResult = { content: [...o.content], details: o.details, isError: o.isError }
  createHint().apply(o, out)
  assert.deepEqual(out.content.map((b) => (b as { text: string }).text.split('\n')[0]), ['first', "NameError: name 'ops' is not defined"])
  assert.ok((out.content[1] as { text: string }).text.includes('%load'))
  assert.equal(out.isError, true)
})

test('the transform declares the ptc feature and is total', () => {
  const hint = createHint()
  assert.deepEqual(hint.features, ['ptc'])
  for (const o of [
    observe({ details: undefined }),
    observe({ content: [] }),
    observe({ content: [{ type: 'text', text: "NameError: name 'ops' is not defined" }], args: null }),
    body(''),
  ]) {
    const out: MutableResult = { content: [...o.content], details: o.details, isError: o.isError }
    assert.doesNotThrow(() => hint.apply(o, out))
  }
})

test('a plain host with no prelude registrar registers the hint exactly once', async () => {
  resetOpsAttachment()
  const before = registeredTransforms().filter((t) => t.name === 'ptc/hint').length
  await attachOps(HOST)
  await attachOps(HOST)
  const after = registeredTransforms().filter((t) => t.name === 'ptc/hint').length
  assert.equal(after - before, 1)
})

test('a host that is not ours installs nothing', async () => {
  resetOpsAttachment()
  const before = registeredTransforms().length
  for (const host of [undefined, null, 'pi', 7, {}]) await attachOps(host)
  assert.equal(registeredTransforms().length, before)
})

test('the hint runs after the renderer and appends to the rendered line', async () => {
  resetOpsAttachment()
  await attachOps(HOST)
  const o = body("NameError: name 'ops' is not defined")
  const out: MutableResult = { content: [...o.content], details: o.details, isError: o.isError }
  runTransforms(o, out, ['ptc'])
  const text = String((out.content[0] as { text: string }).text)
  assert.ok(text.startsWith("NameError: name 'ops' is not defined"), text)
  assert.equal(text.trimEnd().split('\n').length, 2)
})
