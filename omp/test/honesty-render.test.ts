import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OUTCOME_KEY, type OutcomeFacts, type ToolObservation } from '../src/host/contracts.ts'
import type { MutableResult } from '../src/pipeline.ts'
import { transform } from '../src/render/outcome-line.ts'

const observation: ToolObservation = {
  tool: 'read',
  args: { path: 'a.txt' },
  content: [{ type: 'text', text: 'body' }],
  details: {},
  isError: true,
}

const facts = (over: Partial<OutcomeFacts> = {}): OutcomeFacts => ({
  status: 'error',
  effectState: 'none',
  retry: 'after-input-change',
  message: 'read failed',
  ...over,
})

const result = (content: unknown[], details: unknown, isError = true): MutableResult => ({
  content,
  details,
  isError,
})

const withFacts = (value: OutcomeFacts, content: unknown[] = [{ type: 'text', text: 'body' }]): MutableResult =>
  result(content, { [OUTCOME_KEY]: value })

const textOf = (out: MutableResult, index = 0): string => {
  const block = out.content[index]
  if (typeof block !== 'object' || block === null || !('text' in block) || typeof block.text !== 'string') {
    throw new Error(`content[${index}] is not a text block`)
  }
  return block.text
}

const line = (value: OutcomeFacts): string =>
  `[outcome: ${value.status} · effect ${value.effectState} · retry ${value.retry}] ${value.message}`

test('declares the frozen identity of the render slice', () => {
  assert.equal(transform.name, 'honesty/render')
  assert.deepEqual(transform.features, ['honesty'])
})

test('a completed result is byte-identical after the transform', () => {
  const out = withFacts(facts({ status: 'completed', effectState: 'none', retry: 'never', message: 'read 4 bytes' }))
  const before = JSON.stringify(out)
  transform.apply(observation, out)
  assert.equal(JSON.stringify(out), before)
  assert.equal(textOf(out), 'body')
})

test('an error fact appends exactly one line carrying status, effect and retry', () => {
  const value = facts()
  const out = withFacts(value)
  transform.apply(observation, out)
  assert.equal(textOf(out), `body\n${line(value)}`)
  assert.equal(textOf(out).split('\n').length, 2)
  assert.ok(textOf(out).includes('outcome: error'))
  assert.ok(textOf(out).includes('effect none'))
  assert.ok(textOf(out).includes('retry after-input-change'))
})

test('every non-completed status renders', () => {
  for (const status of ['partial', 'rejected', 'conflict', 'unknown'] as const) {
    const value = facts({ status })
    const out = withFacts(value)
    transform.apply(observation, out)
    assert.equal(textOf(out), `body\n${line(value)}`)
  }
})

test('nextAction becomes a second clause on the same line', () => {
  const value = facts({ nextAction: 'Re-read the file before editing' })
  const out = withFacts(value)
  transform.apply(observation, out)
  assert.equal(textOf(out), `body\n${line(value)} Next: Re-read the file before editing`)
  assert.equal(textOf(out).split('\n').length, 2)
})

test('no Next clause when nextAction is absent or empty', () => {
  const absent = withFacts(facts())
  transform.apply(observation, absent)
  assert.ok(!textOf(absent).includes('Next:'))

  const empty = withFacts(facts({ nextAction: '' }))
  transform.apply(observation, empty)
  assert.ok(!textOf(empty).includes('Next:'))
})

test('applying twice appends nothing the second time', () => {
  const out = withFacts(facts({ nextAction: 'Inspect the directory' }))
  transform.apply(observation, out)
  const afterFirst = JSON.stringify(out)
  transform.apply(observation, out)
  assert.equal(JSON.stringify(out), afterFirst)
  assert.equal(textOf(out).split('\n').length, 2)
})

test('an already-rendered line with a trailing newline is not duplicated', () => {
  const value = facts()
  const body = `body\n${line(value)}\n`
  const out = withFacts(value, [{ type: 'text', text: body }])
  transform.apply(observation, out)
  assert.equal(textOf(out), body)
})

test('an image-only content array is untouched', () => {
  const content = [
    { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    { type: 'image', data: 'BBBB', mimeType: 'image/png' },
  ]
  const out = withFacts(facts(), content)
  const before = JSON.stringify(out)
  transform.apply(observation, out)
  assert.equal(JSON.stringify(out), before)
  assert.equal(out.content.length, 2)
})

test('a content array with no text block is untouched rather than extended', () => {
  const out = withFacts(facts(), [{ type: 'tool', name: 'read' }, null])
  const before = JSON.stringify(out)
  transform.apply(observation, out)
  assert.equal(JSON.stringify(out), before)
})

test('details without outcome.v1 are untouched', () => {
  const out = result([{ type: 'text', text: 'body' }], { bytes: 4 })
  const before = JSON.stringify(out)
  transform.apply(observation, out)
  assert.equal(JSON.stringify(out), before)
})

test('an undefined details value is untouched and does not throw', () => {
  const out = result([{ type: 'text', text: 'body' }], undefined)
  const before = JSON.stringify(out)
  assert.doesNotThrow(() => transform.apply(observation, out))
  assert.equal(JSON.stringify(out), before)
})

test('half-understood facts are rejected like no facts at all', () => {
  const out = result([{ type: 'text', text: 'body' }], { [OUTCOME_KEY]: { status: 'error' } })
  const before = JSON.stringify(out)
  transform.apply(observation, out)
  assert.equal(JSON.stringify(out), before)
})

test('the line goes on the last text block, even with later non-text blocks', () => {
  const value = facts()
  const out = withFacts(
    value,
    [
      { type: 'text', text: 'first' },
      { type: 'image', data: 'AAAA' },
      { type: 'text', text: 'last' },
      { type: 'image', data: 'BBBB' },
    ],
  )
  transform.apply(observation, out)
  assert.equal(textOf(out, 0), 'first')
  assert.equal(textOf(out, 2), `last\n${line(value)}`)
  assert.deepEqual(out.content[1], { type: 'image', data: 'AAAA' })
  assert.deepEqual(out.content[3], { type: 'image', data: 'BBBB' })
})

test('a block already ending in a newline gets no extra separator', () => {
  const value = facts()
  const out = withFacts(value, [{ type: 'text', text: 'body\n' }])
  transform.apply(observation, out)
  assert.equal(textOf(out), `body\n${line(value)}`)
})

test('extra block fields survive, frozen blocks are replaced rather than mutated', () => {
  const value = facts()
  const block = Object.freeze({ type: 'text', text: 'body', cache_control: { type: 'ephemeral' } })
  const out = withFacts(value, [block])
  transform.apply(observation, out)
  assert.notEqual(out.content[0], block)
  assert.deepEqual(out.content[0], {
    type: 'text',
    text: `body\n${line(value)}`,
    cache_control: { type: 'ephemeral' },
  })
})

test('isError and details are never changed', () => {
  const details = { [OUTCOME_KEY]: facts() }
  const out = result([{ type: 'text', text: 'body' }], details, true)
  transform.apply(observation, out)
  assert.equal(out.isError, true)
  assert.equal(out.details, details)
  assert.deepEqual(details, { [OUTCOME_KEY]: facts() })
})
