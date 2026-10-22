import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { ToolObservation } from '../src/host/contracts.ts'
import { grepTarget } from '../src/dedup/targets/grep.ts'

const TEXT = ['src/a.ts:12:const needle = 1', 'src/a.ts:40:needle(2)', 'src/b.ts:7:  // needle here'].join('\n')

const complete = (): ToolObservation => ({
  tool: 'grep',
  args: { pattern: 'needle', path: 'src' },
  content: [{ type: 'text', text: TEXT }],
  details: { matchCount: 3, fileCount: 2 },
  isError: false,
})

const textOnly = (text: string): ToolObservation => ({
  ...complete(),
  content: [{ type: 'text', text }],
})

test('a complete multi-file result yields a candidate whose revision hashes the exact text', () => {
  const facts = grepTarget.extract(complete())
  assert.ok(facts, 'a complete grep result must participate in dedup')
  assert.equal(facts.body, TEXT)
  assert.match(facts.revision, /^[0-9a-f]{64}$/)
  assert.equal(facts.revision, createHash('sha256').update(TEXT).digest('hex'))
  assert.equal(facts.key, JSON.stringify(['grep', complete().args, facts.revision]))
  // grep names no single file: the zero identity says "keyed by bytes, not by an inode".
  assert.deepEqual(facts.identity, { dev: 0n, ino: 0n, size: 0n, mtimeNs: 0n, ctimeNs: 0n })
})

test('a truncated result is a page, never a complete body', () => {
  const facts = grepTarget.extract({ ...complete(), details: { matchCount: 3, fileCount: 2, truncated: true } })
  assert.equal(facts, undefined)
})

test('fileLimitReached alone disqualifies the result', () => {
  const facts = grepTarget.extract({ ...complete(), details: { matchCount: 3, fileCount: 2, fileLimitReached: true } })
  assert.equal(facts, undefined)
})

test('perFileLimitReached alone disqualifies the result', () => {
  const facts = grepTarget.extract({
    ...complete(),
    details: { matchCount: 3, fileCount: 2, perFileLimitReached: true },
  })
  assert.equal(facts, undefined)
})

test('linesTruncated alone disqualifies the result', () => {
  const facts = grepTarget.extract({ ...complete(), details: { matchCount: 3, fileCount: 2, linesTruncated: true } })
  assert.equal(facts, undefined)
})

test('explicitly false flags still allow dedup', () => {
  const facts = grepTarget.extract({
    ...complete(),
    details: { matchCount: 3, fileCount: 2, truncated: false, fileLimitReached: false, perFileLimitReached: false, linesTruncated: false },
  })
  assert.ok(facts)
})

test('"No matches found" proves nothing and is not deduped', () => {
  assert.equal(grepTarget.extract(textOnly('No matches found')), undefined)
})

test('a paged-out continuation text is not deduped', () => {
  assert.equal(grepTarget.extract(textOnly('No more results after skip=200')), undefined)
})

test('a paged continuation carrying skip is not deduped', () => {
  const facts = grepTarget.extract({ ...complete(), args: { pattern: 'needle', path: 'src', skip: 200 } })
  assert.equal(facts, undefined)
})

test('skip <= 0 is still the first page and remains eligible', () => {
  const facts = grepTarget.extract({ ...complete(), args: { pattern: 'needle', path: 'src', skip: 0 } })
  assert.ok(facts)
})

test('identical text and args yield the same key; different text yields a different key', () => {
  const first = grepTarget.extract(complete())
  const again = grepTarget.extract(complete())
  const changed = grepTarget.extract(textOnly(`${TEXT}\nsrc/c.ts:3:needle(3)`))
  assert.ok(first)
  assert.ok(again)
  assert.ok(changed)
  assert.equal(first.key, again.key)
  assert.notEqual(first.key, changed.key)
  assert.notEqual(first.revision, changed.revision)
})

test('a different query over identical text yields a different key', () => {
  const first = grepTarget.extract(complete())
  const second = grepTarget.extract({ ...complete(), args: { pattern: 'needle', path: 'lib' } })
  assert.ok(first)
  assert.ok(second)
  assert.equal(first.revision, second.revision)
  assert.notEqual(first.key, second.key)
})

test('results that are not one plain text block are not deduped', () => {
  assert.equal(grepTarget.extract({ ...complete(), content: [] }), undefined)
  assert.equal(
    grepTarget.extract({
      ...complete(),
      content: [{ type: 'text', text: TEXT }, { type: 'text', text: 'second block' }],
    }),
    undefined,
  )
  assert.equal(grepTarget.extract({ ...complete(), content: [{ type: 'image', text: TEXT }] }), undefined)
  assert.equal(grepTarget.extract({ ...complete(), content: [{ type: 'text' }] }), undefined)
})

test('only successful grep observations are dedup targets', () => {
  assert.equal(grepTarget.extract({ ...complete(), tool: 'read' }), undefined)
  assert.equal(grepTarget.extract({ ...complete(), isError: true }), undefined)
})

test('details must prove a complete scan', () => {
  assert.equal(grepTarget.extract({ ...complete(), details: undefined }), undefined)
  assert.equal(grepTarget.extract({ ...complete(), details: 'matchCount=3' }), undefined)
  assert.equal(grepTarget.extract({ ...complete(), details: { fileCount: 2 } }), undefined)
  assert.equal(grepTarget.extract({ ...complete(), details: { matchCount: 3 } }), undefined)
  assert.equal(grepTarget.extract({ ...complete(), details: { matchCount: 3, fileCount: 0 } }), undefined)
  assert.equal(grepTarget.extract({ ...complete(), details: { matchCount: '3', fileCount: 2 } }), undefined)
})
