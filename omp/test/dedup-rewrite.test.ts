import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rewriteBody } from '../src/dedup/rewrite.ts'

const CALL_ID = 'call-7f3a'
const MESSAGE_ID = 'msg-0192'

const reference = (callId: string, messageId: string): string =>
  `[Notice: Unchanged file range; body already present in the current model context in tool call ${JSON.stringify(callId)} / message ${JSON.stringify(messageId)}. Fresh read revalidated the revision above.]`

const REFERENCE = reference(CALL_ID, MESSAGE_ID)

const countOf = (haystack: string, needle: string): number => haystack.split(needle).length - 1

/** A realistic read body: numbered source lines plus the read tool's display notice. */
const numberedBody = [
  '1 | import { readFile } from "node:fs/promises"',
  '2 | import { createHash } from "node:crypto"',
  '3 |',
  '4 | export interface Loaded {',
  '5 |   readonly path: string',
  '6 |   readonly text: string',
  '7 |   readonly revision: string',
  '8 | }',
  '9 |',
  '10 | export async function load(path: string): Promise<Loaded> {',
  '11 |   const text = await readFile(path, "utf8")',
  '12 |   const revision = createHash("sha256").update(text).digest("hex")',
  '13 |   return { path, text, revision }',
  '14 | }',
  '[Notice: 14 items displayed; requested ranges returned.]',
].join('\n')

test('compacts a numbered body: strips prefixes, rewrites the notice, appends one reference line', () => {
  const result = rewriteBody(numberedBody, CALL_ID, MESSAGE_ID)
  assert.ok(result, 'a body far longer than the reference line must compact')
  const { text } = result

  assert.deepEqual(
    text.split('\n').filter((line) => /^\d+(?: \| |\|)/.test(line)),
    [],
    'every numbered content line is stripped',
  )
  assert.equal(text.includes('1 | import'), false)
  assert.equal(text.includes('10 |'), false)

  assert.equal(text.includes('[Notice: 14 items revalidated;'), true)
  assert.equal(text.includes('displayed;'), false)
  assert.equal(text.includes('requested ranges revalidated.'), true)
  assert.equal(text.includes('requested ranges returned.'), false)

  assert.equal(countOf(text, '[Notice: Unchanged file range;'), 1, 'exactly one reference line')
  assert.equal(text.split('\n').at(-1), REFERENCE, 'the reference line is last and exact')
})

test('the rewrite is strictly shorter than the body it replaces', () => {
  const result = rewriteBody(numberedBody, CALL_ID, MESSAGE_ID)
  assert.ok(result)
  assert.ok(
    Buffer.byteLength(result.text, 'utf8') < Buffer.byteLength(numberedBody, 'utf8'),
    'compacted body must save bytes',
  )
})

test('a short unnumbered body returns undefined instead of growing', () => {
  const body = 'alpha\nbeta\ngamma'
  assert.equal(rewriteBody(body, CALL_ID, MESSAGE_ID), undefined)
  assert.ok(Buffer.byteLength(REFERENCE, 'utf8') > Buffer.byteLength(body, 'utf8'))
})

test('equal-length compaction is rejected: the comparison is strict', () => {
  const referenceLength = Buffer.byteLength(REFERENCE, 'utf8')
  // `1 | ` costs 4 bytes and the line is dropped, leaving exactly REFERENCE behind.
  const equalLength = `1 | ${'x'.repeat(referenceLength - 4)}`
  assert.equal(Buffer.byteLength(equalLength, 'utf8'), referenceLength)
  assert.equal(rewriteBody(equalLength, CALL_ID, MESSAGE_ID), undefined, 'no saving means no rewrite')

  const oneByteLonger = `1 | ${'x'.repeat(referenceLength - 3)}`
  assert.deepEqual(rewriteBody(oneByteLonger, CALL_ID, MESSAGE_ID), { text: REFERENCE })
})

test('re-running on its own output never appends a second reference line', () => {
  const first = rewriteBody(numberedBody, CALL_ID, MESSAGE_ID)
  assert.ok(first)
  assert.equal(rewriteBody(first.text, CALL_ID, MESSAGE_ID), undefined, 'a second pass must not rewrite')
  // Even if a caller ignored `undefined`, the text it holds keeps a single reference line.
  assert.equal(countOf(first.text, '[Notice: Unchanged file range;'), 1)
})

test('callId and messageId are JSON-quoted in the output', () => {
  const callId = 'call"with\\slashes'
  const messageId = 'msg-0192'

  const result = rewriteBody(numberedBody, callId, messageId)
  assert.ok(result)
  assert.equal(result.text.includes(`tool call ${JSON.stringify(callId)}`), true)
  assert.equal(result.text.includes(`message ${JSON.stringify(messageId)}`), true)
  assert.equal(result.text.endsWith(reference(callId, messageId)), true)
  assert.equal(result.text.includes('call"with'), false, 'the raw unquoted id never appears')
})
