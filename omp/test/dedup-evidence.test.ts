import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { identityOf, proveRecord } from '../src/dedup/evidence.ts'
import type { FileIdentity, ReadRecord } from '../src/dedup/types.ts'

const BODY = 'alpha\nbeta\ngamma\n'
const SIZE = BigInt(Buffer.byteLength(BODY))

/** Per-test sandbox under os.tmpdir(); removed when the test ends even if it fails. */
const sandbox = (t: TestContext): string => {
  const dir = mkdtempSync(join(tmpdir(), 'omp-dedup-evidence-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const makeFile = (dir: string, name = 'note.txt', body = BODY): string => {
  const path = join(dir, name)
  writeFileSync(path, body)
  return path
}

const record = (over: Partial<ReadRecord> = {}): ReadRecord => ({
  agentKey: 'agent-a',
  epoch: 1,
  key: '["read",{"path":"note.txt"},[]]',
  body: BODY,
  bytes: Number(SIZE),
  identity: { dev: 1n, ino: 2n, size: SIZE, mtimeNs: 3n, ctimeNs: 4n },
  revision: 'a'.repeat(64),
  ...over,
})

const IDENTITY_FIELDS = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const

test('a regular file yields the full lstat identity', (t) => {
  const dir = sandbox(t)
  const path = makeFile(dir)

  const identity = identityOf(path, SIZE)
  assert.ok(identity, 'a regular file of the expected size must have an identity')
  const stat = lstatSync(path, { bigint: true })
  assert.deepEqual(identity, {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  })
  for (const field of IDENTITY_FIELDS) {
    assert.equal(typeof identity[field], 'bigint', `${field} must stay a bigint`)
  }
  assert.notEqual(identity.ino, 0n, 'a proven identity needs a real inode number')
  assert.deepEqual(identityOf(path, SIZE), identity, 'an untouched file keeps the same identity')
})

test('a directory and a missing path have no identity', (t) => {
  const dir = sandbox(t)
  const subdir = join(dir, 'sub')
  mkdirSync(subdir)

  assert.equal(identityOf(subdir, 0n), undefined, 'a directory is not a readable body')
  assert.equal(identityOf(join(dir, 'absent.txt'), SIZE), undefined, 'a missing path proves nothing')
})

test('a size mismatch has no identity', (t) => {
  const dir = sandbox(t)
  const path = makeFile(dir)

  assert.equal(identityOf(path, SIZE + 1n), undefined)
  assert.equal(identityOf(path, SIZE - 1n), undefined)
})

test('a symlink to a regular file has no identity', (t) => {
  const dir = sandbox(t)
  const target = makeFile(dir)
  const link = join(dir, 'link.txt')
  try {
    symlinkSync(target, link)
  } catch (error) {
    t.skip(`platform refused the symlink: ${String((error as NodeJS.ErrnoException).code)}`)
    return
  }

  assert.equal(identityOf(link, SIZE), undefined, 'a symlink must be judged as itself, not as its target')
})

test('touching the file changes mtimeNs and breaks the proof', (t) => {
  const dir = sandbox(t)
  const path = makeFile(dir)

  const before = identityOf(path, SIZE)
  assert.ok(before)
  const touched = new Date('2020-01-02T03:04:05Z')
  utimesSync(path, touched, touched)
  const after = identityOf(path, SIZE)
  assert.ok(after)

  assert.notEqual(after.mtimeNs, before.mtimeNs, 'mtimeNs must be re-read, not reused')
  assert.equal(proveRecord(record({ identity: before }), { agentKey: 'agent-a', epoch: 1, identity: after }), false)
})

test('identical agent, epoch and identity prove the record', (t) => {
  const dir = sandbox(t)
  const identity = identityOf(makeFile(dir), SIZE)
  assert.ok(identity)

  assert.equal(proveRecord(record({ identity }), { agentKey: 'agent-a', epoch: 1, identity }), true)
})

test('an epoch or agent mismatch refuses the record', (t) => {
  const dir = sandbox(t)
  const identity = identityOf(makeFile(dir), SIZE)
  assert.ok(identity)

  assert.equal(proveRecord(record({ identity }), { agentKey: 'agent-a', epoch: 2, identity }), false, 'epoch drift')
  assert.equal(proveRecord(record({ identity }), { agentKey: 'agent-b', epoch: 1, identity }), false, 'other agent')
  assert.equal(
    proveRecord(record({ identity, epoch: 0 }), { agentKey: 'agent-a', epoch: 1, identity }),
    false,
    'the epoch must match in both directions',
  )
})

test('any single identity field mismatch refuses the record', (t) => {
  const dir = sandbox(t)
  const identity = identityOf(makeFile(dir), SIZE)
  assert.ok(identity)

  for (const field of IDENTITY_FIELDS) {
    const drifted: FileIdentity = { ...identity, [field]: identity[field] + 1n }
    assert.equal(
      proveRecord(record({ identity }), { agentKey: 'agent-a', epoch: 1, identity: drifted }),
      false,
      `${field} changed`,
    )
    assert.equal(
      proveRecord(record({ identity: drifted }), { agentKey: 'agent-a', epoch: 1, identity }),
      false,
      `${field} changed in the record`,
    )
  }
})

test('malformed inputs are refused instead of thrown', (t) => {
  const dir = sandbox(t)
  const identity = identityOf(makeFile(dir), SIZE)
  assert.ok(identity)

  assert.equal(identityOf('', 0n), undefined)
  assert.equal(identityOf(join(dir, '\u0000bad'), 0n), undefined)
  assert.equal(proveRecord(undefined as unknown as ReadRecord, { agentKey: 'agent-a', epoch: 1, identity }), false)
  assert.equal(
    proveRecord(record(), { agentKey: 'agent-a', epoch: 1, identity: undefined as unknown as FileIdentity }),
    false,
  )
  const partial = { dev: identity.dev } as unknown as FileIdentity
  assert.equal(proveRecord(record({ identity: partial }), { agentKey: 'agent-a', epoch: 1, identity: partial }), false)
})
