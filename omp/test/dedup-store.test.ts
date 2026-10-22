import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStore, MAX_AGENTS, MAX_BODY_BYTES, MAX_RECORDS } from '../src/dedup/store.ts'
import type { FileIdentity, ReadRecord } from '../src/dedup/types.ts'

const identity = (size = 4n): FileIdentity => ({ dev: 1n, ino: 2n, size, mtimeNs: 3n, ctimeNs: 4n })

const record = (
  agentKey: string,
  key: string,
  { epoch = 0, bytes = 4, body = 'body' }: { epoch?: number; bytes?: number; body?: string } = {},
): ReadRecord => ({ agentKey, epoch, key, body, bytes, identity: identity(), revision: 'r1' })

test('a record is a hit only when agent, epoch and key all match', () => {
  const store = createStore()
  const saved = record('agent-a', 'read:a.txt')
  store.remember(saved)

  assert.deepEqual(store.lookup('agent-a', 0, 'read:a.txt'), saved)
  assert.equal(store.lookup('agent-a', 1, 'read:a.txt'), undefined, 'epoch mismatch must miss')
  assert.equal(store.lookup('agent-b', 0, 'read:a.txt'), undefined, 'other agent must miss')
  assert.equal(store.lookup('agent-a', 0, 'read:b.txt'), undefined, 'other key must miss')
  assert.equal(store.size(), 1, 'a miss never mutates the store')
  assert.equal(store.bytes(), 4)
  store.dispose()
})

test('re-remembering a key replaces it in place and keeps it most recent', () => {
  const store = createStore()
  store.remember(record('agent-a', 'first', { bytes: 4, body: 'aaaa' }))
  store.remember(record('agent-a', 'second', { bytes: 8, body: 'bbbbbbbb' }))
  store.remember(record('agent-a', 'first', { bytes: 6, body: 'aaaaaa' }))

  assert.equal(store.size(), 2, 'replacement does not add a record')
  assert.equal(store.bytes(), 14, 'the replaced body stops counting')
  assert.equal(store.lookup('agent-a', 0, 'first')?.body, 'aaaaaa')
  store.dispose()
})

test('the 33rd record for one agent evicts its oldest, and refresh order decides the victim', () => {
  const store = createStore()
  for (let index = 0; index <= MAX_RECORDS; index++) store.remember(record('agent-a', `k${index}`))

  assert.equal(store.size(), MAX_RECORDS)
  assert.equal(store.bytes(), MAX_RECORDS * 4)
  assert.equal(store.lookup('agent-a', 0, 'k0'), undefined, 'oldest record is evicted first')
  assert.equal(store.lookup('agent-a', 0, 'k1')?.key, 'k1')
  assert.equal(store.lookup('agent-a', 0, `k${MAX_RECORDS}`)?.key, `k${MAX_RECORDS}`, 'newest survives')

  // Refreshing k1 makes it the most recent, so k2 is now the oldest.
  store.remember(record('agent-a', 'k1'))
  store.remember(record('agent-a', 'extra'))
  assert.equal(store.lookup('agent-a', 0, 'k1')?.key, 'k1', 'a refresh protects the record')
  assert.equal(store.lookup('agent-a', 0, 'k2'), undefined, 'the next-oldest goes instead')
  assert.equal(store.size(), MAX_RECORDS)
  store.dispose()
})

test('the record cap is per agent, not store-wide', () => {
  const store = createStore()
  for (let agent = 0; agent < 2; agent++) {
    for (let index = 0; index <= MAX_RECORDS; index++) store.remember(record(`agent-${agent}`, `k${index}`))
  }
  assert.equal(store.size(), 2 * MAX_RECORDS)
  assert.equal(store.lookup('agent-0', 0, 'k1')?.key, 'k1', 'agent-0 keeps its own window')
  store.dispose()
})

test('the 17th agent evicts the oldest agent and every record it held', () => {
  const store = createStore()
  for (let agent = 0; agent < MAX_AGENTS; agent++) {
    store.remember(record(`agent-${agent}`, 'a'))
    store.remember(record(`agent-${agent}`, 'b'))
  }
  assert.equal(store.size(), MAX_AGENTS * 2)

  store.remember(record(`agent-${MAX_AGENTS}`, 'a'))
  assert.equal(store.size(), MAX_AGENTS * 2 - 1, 'the evicted agent takes its two records with it')
  assert.equal(store.bytes(), (MAX_AGENTS * 2 - 1) * 4)
  assert.equal(store.lookup('agent-0', 0, 'a'), undefined)
  assert.equal(store.lookup('agent-0', 0, 'b'), undefined, 'the whole oldest agent is dropped')
  assert.equal(store.lookup('agent-1', 0, 'a')?.key, 'a', 'the second-oldest agent is untouched')
  assert.equal(store.lookup(`agent-${MAX_AGENTS}`, 0, 'a')?.key, 'a')
  store.dispose()
})

test('body bytes never exceed 2 MiB and an oversized body is refused, not stored', () => {
  const store = createStore()
  const big = MAX_BODY_BYTES / 2

  store.remember(record('agent-a', 'half-1', { bytes: big }))
  store.remember(record('agent-a', 'half-2', { bytes: big }))
  assert.equal(store.bytes(), MAX_BODY_BYTES)

  store.remember(record('agent-b', 'half-3', { bytes: big }))
  assert.equal(store.bytes(), MAX_BODY_BYTES, 'the budget is never exceeded')
  assert.equal(store.lookup('agent-a', 0, 'half-1'), undefined, 'the oldest body is evicted to make room')
  assert.equal(store.lookup('agent-b', 0, 'half-3')?.key, 'half-3')

  const before = { size: store.size(), bytes: store.bytes() }
  store.remember(record('agent-c', 'too-big', { bytes: MAX_BODY_BYTES + 1 }))
  assert.deepEqual({ size: store.size(), bytes: store.bytes() }, before, 'an oversized body changes nothing')
  assert.equal(store.lookup('agent-c', 0, 'too-big'), undefined)

  const empty = createStore()
  empty.remember(record('agent-a', 'too-big', { bytes: MAX_BODY_BYTES + 1 }))
  assert.equal(empty.size(), 0, 'nothing is stored when the body alone exceeds the budget')
  assert.equal(empty.bytes(), 0)
  store.dispose()
  empty.dispose()
})

test('forget drops exactly one agent', () => {
  const store = createStore()
  store.remember(record('agent-a', 'a', { bytes: 5 }))
  store.remember(record('agent-a', 'b', { bytes: 7 }))
  store.remember(record('agent-b', 'a', { bytes: 11 }))

  store.forget('agent-a')
  assert.equal(store.size(), 1)
  assert.equal(store.bytes(), 11)
  assert.equal(store.lookup('agent-a', 0, 'a'), undefined)
  assert.equal(store.lookup('agent-b', 0, 'a')?.key, 'a', 'other agents survive a forget')

  store.forget('agent-a')
  assert.equal(store.size(), 1, 'forgetting an unknown agent is a no-op')
  assert.equal(store.bytes(), 11)
  store.dispose()
})

test('dispose empties every counter', () => {
  const store = createStore()
  store.remember(record('agent-a', 'a'))
  store.remember(record('agent-b', 'a'))
  store.dispose()

  assert.equal(store.size(), 0)
  assert.equal(store.bytes(), 0)
  assert.equal(store.lookup('agent-a', 0, 'a'), undefined)
  store.dispose()
  assert.equal(store.size(), 0)
})
