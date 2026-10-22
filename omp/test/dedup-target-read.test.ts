import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { ToolObservation } from '../src/host/contracts.ts'
import { readTarget } from '../src/dedup/targets/read.ts'

let root: string
let file: string

const BODY = 'line one\nline two\n'
const OTHER_BODY = 'replaced body\n'

const detailsFor = (path: string): unknown => ({ meta: { source: { type: 'path', value: path } } })

const observation = (over: Partial<ToolObservation> = {}): ToolObservation => ({
  tool: 'read',
  args: { path: file },
  content: [{ type: 'text', text: BODY }],
  details: detailsFor(file),
  isError: false,
  ...over,
})

before(() => {
  root = mkdtempSync(join(tmpdir(), 'omp-dedup-target-read-'))
  file = join(root, 'body.txt')
  writeFileSync(file, BODY)
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

test('a single-text read of a real file yields a candidate with a computed sha256 revision', () => {
  const candidate = readTarget.extract(observation())
  assert.ok(candidate, 'a plain successful read of an existing file is eligible')
  assert.equal(candidate.body, BODY)
  assert.equal(
    candidate.revision,
    createHash('sha256').update(BODY).digest('hex'),
    'revision must be the sha256 of the body, not a host-supplied or invented value',
  )
  assert.match(candidate.revision, /^[0-9a-f]{64}$/)
  assert.equal(candidate.key.length > 0, true)

  const stat = statSync(file, { bigint: true })
  assert.equal(candidate.identity.dev, stat.dev)
  assert.equal(candidate.identity.ino, stat.ino)
  assert.equal(candidate.identity.size, stat.size)
  assert.equal(candidate.identity.mtimeNs, stat.mtimeNs)
  assert.equal(candidate.identity.ctimeNs, stat.ctimeNs)
})

test('an error result is never eligible', () => {
  assert.equal(readTarget.extract(observation({ isError: true })), undefined)
})

test('only the read tool is eligible', () => {
  assert.equal(readTarget.extract(observation({ tool: 'grep' })), undefined)
  assert.equal(readTarget.extract(observation({ tool: 'bash' })), undefined)
})

test('a body is eligible only when it is exactly one text block', () => {
  assert.equal(
    readTarget.extract(
      observation({
        content: [
          { type: 'text', text: BODY },
          { type: 'text', text: 'trailing note' },
        ],
      }),
    ),
    undefined,
  )
  assert.equal(readTarget.extract(observation({ content: [] })), undefined)
  assert.equal(readTarget.extract(observation({ content: [{ type: 'image', data: 'AAAA' }] })), undefined)
  assert.equal(readTarget.extract(observation({ content: [{ type: 'text', text: 7 }] })), undefined)
})

test('a body truncated by the output budget is never eligible', () => {
  const truncated = `line one\n\n[TruncatedBy: output-budget — 412 more lines]\n`
  assert.equal(readTarget.extract(observation({ content: [{ type: 'text', text: truncated }] })), undefined)
})

test('only a mutable details record carrying an absolute path source is eligible', () => {
  assert.equal(readTarget.extract(observation({ details: undefined })), undefined)
  assert.equal(readTarget.extract(observation({ details: {} })), undefined)
  assert.equal(readTarget.extract(observation({ details: { meta: {} } })), undefined)
  assert.equal(
    readTarget.extract(observation({ details: { meta: { source: { type: 'url', value: 'https://example.test/a.txt' } } } })),
    undefined,
  )
  assert.equal(
    readTarget.extract(observation({ details: { meta: { source: { type: 'path', value: 'relative/body.txt' } } } })),
    undefined,
  )
  assert.equal(
    readTarget.extract(observation({ details: Object.freeze(detailsFor(file)) })),
    undefined,
  )
})

test('a directory or a path that vanished falls through', () => {
  assert.equal(readTarget.extract(observation({ details: detailsFor(root) })), undefined)
  assert.equal(readTarget.extract(observation({ details: detailsFor(join(root, 'missing.txt')) })), undefined)
})

test('the key is stable for the same args and file, and changes when either does', () => {
  const first = readTarget.extract(observation())
  const again = readTarget.extract(observation())
  assert.ok(first && again)
  assert.equal(again.key, first.key)

  const shifted = readTarget.extract(observation({ args: { path: file, offset: 2 } }))
  assert.ok(shifted)
  assert.notEqual(shifted.key, first.key)

  writeFileSync(file, OTHER_BODY)
  utimesSync(file, new Date(1_700_000_000_000), new Date(1_700_000_000_000))
  const rewritten = readTarget.extract(
    observation({ args: { path: file, offset: 2 }, content: [{ type: 'text', text: OTHER_BODY }] }),
  )
  assert.ok(rewritten)
  assert.notEqual(rewritten.key, first.key, 'a rewritten file must not reuse the old key')
  assert.equal(rewritten.revision, createHash('sha256').update(OTHER_BODY).digest('hex'))

  writeFileSync(file, BODY)
})
