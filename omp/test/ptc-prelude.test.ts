import assert from 'node:assert/strict'
import { isAbsolute, normalize, sep } from 'node:path'
import { test } from 'node:test'
import { OPS_PRELUDE_PATH, installPrelude, type PreludeInstall } from '../src/ptc/prelude.ts'
import { record } from '../src/ptc/types.ts'

/** The members a real omp extension host has. `%load` rides on the same host, not on a registrar. */
const ompHost = (over: Record<string, unknown> = {}) => ({ on() {}, registerTool() {}, registerCommand() {}, ...over })

const definitionOf = (value: unknown) => {
  const definition = record(value)
  if (!definition) assert.fail(`expected a prelude definition object, received ${typeof value}`)
  return definition
}

test('a host with no registration surface installs nothing', async () => {
  const hosts: unknown[] = [undefined, null, 42, 'eval', [], {}, { unrelated: () => 1 }]
  for (const host of hosts) {
    const result = await installPrelude(host)
    // An unusable host is answered with a channel name, never thrown at and never guessed at.
    assert.equal(result, 'none', `host ${JSON.stringify(host) ?? String(host)}`)
  }
})

test('a host that throws while being inspected installs nothing instead of failing the load', async () => {
  const unreadable = {
    get registerTool(): never {
      throw new Error('host exploded')
    },
  }
  assert.equal(await installPrelude(unreadable), 'none')

  // A readable host whose registrar member cannot be read still resolves to the fallback channel.
  // Built without a spread on purpose: spreading would evaluate the getter in this file.
  const unreadableRegistrar = {
    on() {},
    registerTool() {},
    get registerEvalPrelude(): never {
      throw new Error('registrar exploded')
    },
  }
  assert.equal(await installPrelude(unreadableRegistrar), 'load-file')
})

test('an extension host without a prelude registrar falls back to %load', async () => {
  // Undocumented in 18.12.6: this is the verdict the real extension API produces.
  assert.equal(await installPrelude(ompHost()), 'load-file')
})

test('a host that accepts the ops definition reports the prelude channel', async () => {
  const seen: unknown[] = []
  const host = ompHost({
    registerEvalPrelude(definition: unknown) {
      seen.push(definition)
    },
  })
  assert.equal(await installPrelude(host), 'prelude')
  assert.equal(seen.length, 1)
  const definition = definitionOf(seen[0])
  assert.equal(definition.name, 'ops')
  assert.deepEqual(definition.exports, ['ops'])
  // The definition names the same script the `%load` channel would: one artefact, two channels.
  assert.equal(definition.module, OPS_PRELUDE_PATH)
})

test('a registrar that refuses or fails degrades to %load rather than throwing', async () => {
  const verdicts: PreludeInstall[] = [
    await installPrelude(ompHost({ registerEvalPrelude: () => false })),
    await installPrelude(
      ompHost({
        registerEvalPrelude: () => {
          throw new Error('registrar rejected the definition')
        },
      }),
    ),
    await installPrelude(
      ompHost({
        registerEvalPrelude: () => Promise.reject(new Error('registrar rejected asynchronously')),
      }),
    ),
  ]
  assert.deepEqual(verdicts, ['load-file', 'load-file', 'load-file'])
})

test('installing twice registers once', async () => {
  let registrations = 0
  const host = ompHost({
    registerEvalPrelude() {
      registrations += 1
    },
  })
  const concurrent = await Promise.all([installPrelude(host), installPrelude(host)])
  assert.deepEqual(concurrent, ['prelude', 'prelude'])
  assert.equal(await installPrelude(host), 'prelude')
  // One registration for one host: a second load pass must not stack a duplicate prelude.
  assert.equal(registrations, 1)
})

test('the %load script it publishes is an absolute, normalised path into the ptc directory', () => {
  assert.equal(isAbsolute(OPS_PRELUDE_PATH), true)
  assert.equal(normalize(OPS_PRELUDE_PATH), OPS_PRELUDE_PATH)
  assert.equal(OPS_PRELUDE_PATH.split(/[\\/]/).includes('..'), false)
  assert.equal(OPS_PRELUDE_PATH.endsWith(`ptc${sep}js${sep}ops.mjs`), true)
})
