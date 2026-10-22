import assert from 'node:assert/strict'
import { test } from 'node:test'
import { observe, OUTCOME_KEY, readOutcome, type ToolObservation } from '../src/host/contracts.ts'
import { errorPolicy } from '../src/kernel/errors.ts'
import type { MutableResult } from '../src/pipeline.ts'
import { transform } from '../src/rules/file.ts'

/**
 * Every payload marked "captured" below was taken from omp 18.12.6 (`omp -p`, DeepSeek tool profile)
 * through a probe extension that appended the raw `tool_result` event to a log. The two payloads
 * marked "synthetic" could not be produced by that build and exist only to pin the conservative
 * default the rule falls back to; they say so in their name.
 *
 * The captured failures share one shape worth remembering: `isError: true`, the message in
 * `content[0].text`, and **no `details` key at all**. That is why the rule installs its own
 * container instead of requiring the host to supply one.
 */

const observation = (raw: Record<string, unknown>): ToolObservation => {
  const observed = observe(raw)
  assert.ok(observed, 'fixture must be a wire payload the host actually sends')
  return observed
}

/** Keeps the host's own `content` array by reference, so identity proves the rule never touched it. */
const run = (o: ToolObservation): MutableResult => {
  const out: MutableResult = { content: o.content as unknown[], details: o.details, isError: o.isError }
  transform.apply(o, out)
  return out
}

const factsFor = (raw: Record<string, unknown>) => {
  const out = run(observation(raw))
  const facts = readOutcome(out.details)
  assert.ok(facts, 'a classified failure must publish outcome.v1')
  return facts
}

/** Ties every assertion to the published table: a hand-written `retry` would fail this. */
const assertDerived = (raw: Record<string, unknown>) => {
  const facts = factsFor(raw)
  const policy = errorPolicy(facts.code ?? '', facts.effectState)
  assert.equal(facts.status, policy.status, 'status must come from errorPolicy')
  assert.equal(facts.retry, policy.retry, 'retry must come from errorPolicy')
  return facts
}

// ---------------------------------------------------------------- captured failures

// read, missing path.
const readMissing = {
  type: 'tool_result',
  toolName: 'read',
  toolCallId: 'call_captured_read_missing',
  input: { path: 'missing-rf.txt' },
  content: [{ type: 'text', text: "Path 'missing-rf.txt' not found" }],
  isError: true,
}

// edit, target does not exist (hashline header names a file the host cannot find).
const editMissing = {
  type: 'tool_result',
  toolName: 'edit',
  toolCallId: 'call_captured_edit_missing',
  input: { input: '[nope-rf.txt#ABCD]\nPUT 1.=1:\n+x', path: 'nope-rf.txt', paths: ['nope-rf.txt'] },
  content: [{ type: 'text', text: 'File not found: nope-rf.txt. Use the write tool to create new files.' }],
  isError: true,
}

// edit, binary target: the host decodes before it edits.
const editBinary = {
  type: 'tool_result',
  toolName: 'edit',
  toolCallId: 'call_captured_edit_binary',
  input: { path: 'bin2.bin', old_string: 'data', new_string: 'meta' },
  content: [{ type: 'text', text: 'bin2.bin is not valid UTF-8 at byte 4; refusing to edit' }],
  isError: true,
}

// edit, a hash the session never issued.
const editForeignTag = {
  type: 'tool_result',
  toolName: 'edit',
  toolCallId: 'call_captured_edit_foreign_tag',
  input: { input: '[a.txt#0000]\nPUT 2.=2:\n+beta2', path: 'a.txt', paths: ['a.txt'] },
  content: [
    {
      type: 'text',
      text: "Edit rejected for a.txt: hash #0000 is not from this session.\nThe file has changed since that tag; re-read it with `read` before editing, then re-issue the edit with the fresh [path#tag] header.\n\n 1:alpha\n*2:beta\n 3:gamma\n 4:",
    },
  ],
  isError: true,
}

// edit, the header names no tag at all.
const editMissingTag = {
  type: 'tool_result',
  toolName: 'edit',
  toolCallId: 'call_captured_edit_missing_tag',
  input: { input: '[a.txt]\nPUT 2.=2:\n+beta2', path: 'a.txt', paths: ['a.txt'] },
  content: [
    {
      type: 'text',
      text: "Edit rejected for a.txt: the header needs this file's current tag, #B6C1.\nThe current file hashes to #B6C1. Re-read the file with `read` to copy a current [path#tag] header \u2014 never invent the tag and never reuse one from a prior session.\n\n 1:alpha\n*2:beta\n 3:gamma\n 4:",
    },
  ],
  isError: true,
}

// edit, anchored to lines the session never displayed (the read had shown a partial range).
const editUnseenLines = {
  type: 'tool_result',
  toolName: 'edit',
  toolCallId: 'call_captured_edit_unseen',
  input: { input: '[long.txt#C6FE]\nPUT 9.=9:\n+nine-changed', path: 'long.txt', paths: ['long.txt'] },
  content: [
    {
      type: 'text',
      text: 'This edit anchors to lines 9 of long.txt that [long.txt#C6FE] never displayed (it showed a partial range, a search hit, or a folded summary). Actual file content at those lines:\n  9:nine\nVerify the content matches what you intend to touch, then re-issue the edit with the same [long.txt#C6FE] header \u2014 a straight retry now succeeds without a re-read. If the content does NOT match, fix your line numbers.',
    },
  ],
  isError: true,
}

// edit, replace-mode search miss.
const editNoMatch = {
  type: 'tool_result',
  toolName: 'edit',
  toolCallId: 'call_captured_edit_no_match',
  input: { path: './a.txt', old_string: 'missing text', new_string: 'x' },
  content: [{ type: 'text', text: 'Could not find a close enough match in ./a.txt.' }],
  isError: true,
}

// write onto a directory path.
const writeDirectory = {
  type: 'tool_result',
  toolName: 'write',
  toolCallId: 'call_captured_write_dir',
  input: { path: 'd.txt', content: 'x' },
  content: [
    {
      type: 'text',
      text: "EISDIR: illegal operation on a directory, open 'C:\\Users\\Toshu\\AppData\\Local\\Temp\\omp-probe-rules-file\\scratch\\d.txt'",
    },
  ],
  isError: true,
}

// write onto a read-only file.
const writeReadOnly = {
  type: 'tool_result',
  toolName: 'write',
  toolCallId: 'call_captured_write_ro',
  input: { path: 'ro.txt', content: 'x' },
  content: [
    {
      type: 'text',
      text: "EPERM: operation not permitted, open 'C:\\Users\\Toshu\\AppData\\Local\\Temp\\omp-probe-rules-file\\scratch\\ro.txt'",
    },
  ],
  isError: true,
}

// ---------------------------------------------------------------- captured successes

// read of a non-UTF-8 file: a notice, not an error, and it carries details.
const readBinaryNotice = {
  type: 'tool_result',
  toolName: 'read',
  toolCallId: 'call_captured_read_binary',
  input: { path: 'enc.txt' },
  content: [
    { type: 'text', text: "[Cannot read binary file 'enc.txt' (29B); not valid UTF-8 text. Use ':raw' to read bytes verbatim.]" },
  ],
  details: {
    resolvedPath: 'C:\\Users\\Toshu\\AppData\\Local\\Temp\\omp-probe-rules-file\\scratch\\enc.txt',
    meta: { source: { type: 'path', value: 'C:\\Users\\Toshu\\AppData\\Local\\Temp\\omp-probe-rules-file\\scratch\\enc.txt' } },
  },
  isError: false,
}

const editSuccess = {
  type: 'tool_result',
  toolName: 'edit',
  toolCallId: 'call_captured_edit_ok',
  input: { path: 'never-read2.txt', old_string: 'zzz', new_string: 'yyy' },
  content: [{ type: 'text', text: '[never-read2.txt]\n1:yyy' }],
  details: {
    diff: '-1|zzz\n+1|yyy',
    firstChangedLine: 1,
    op: 'update',
    path: 'C:\\Users\\Toshu\\AppData\\Local\\Temp\\omp-probe-rules-file\\scratch\\never-read2.txt',
    oldText: 'zzz\n',
    newText: 'yyy\n',
  },
  isError: false,
}

const writeSuccess = {
  type: 'tool_result',
  toolName: 'write',
  toolCallId: 'call_captured_write_ok',
  input: { path: 'out.txt', content: 'x\n' },
  content: [{ type: 'text', text: 'Wrote 2B to out.txt' }],
  details: { resolvedPath: 'C:\\Users\\Toshu\\AppData\\Local\\Temp\\omp-probe-rules-file\\scratch\\out.txt' },
  isError: false,
}

// ---------------------------------------------------------------- synthetic gaps

// No unrecognised `write` failure was reachable in 18.12.6: a directory and a read-only target are
// the only write refusals the host produces, and both fail at `open`. The default still needs a
// fixture, so this one names the shape it guards: a syscall that may have landed half a file.
const writeUnknownEffect = {
  type: 'tool_result',
  toolName: 'write',
  toolCallId: 'call_synthetic_write_unknown',
  input: { path: 'big.bin', content: 'x' },
  content: [{ type: 'text', text: "ENOSPC: no space left on device, write" }],
  isError: true,
}

// Same gap for `edit`: every rejection the host emits matched a known pattern.
const editUnknownEffect = {
  type: 'tool_result',
  toolName: 'edit',
  toolCallId: 'call_synthetic_edit_unknown',
  input: { path: 'a.txt', old_string: 'x', new_string: 'y' },
  content: [{ type: 'text', text: 'EIO: i/o error, write' }],
  isError: true,
}

// ---------------------------------------------------------------- mappings

test('read: missing path is not-found, nothing written, retry after fixing the path', () => {
  const facts = assertDerived(readMissing)
  assert.equal(facts.code, 'NOT_FOUND')
  assert.equal(facts.effectState, 'none')
  assert.equal(facts.retry, 'after-input-change')
  assert.match(facts.message, /nothing was read and nothing was written/)
})

test('edit: a missing target is not-found and wrote nothing', () => {
  const facts = assertDerived(editMissing)
  assert.equal(facts.code, 'NOT_FOUND')
  assert.equal(facts.effectState, 'none')
  assert.match(facts.message, /nothing was written/)
})

test('edit: a non-UTF-8 target is an encoding refusal, not a conflict', () => {
  const facts = assertDerived(editBinary)
  assert.equal(facts.code, 'ERR_INVALID_ENCODING')
  assert.equal(facts.effectState, 'none')
  assert.match(facts.message, /not valid UTF-8/)
})

test('edit: a foreign hash is a pre-write rejection and says so', () => {
  const facts = assertDerived(editForeignTag)
  assert.equal(facts.code, 'EDIT_CONFLICT')
  assert.equal(facts.effectState, 'none')
  assert.match(facts.message, /tag/)
  assert.match(facts.message, /nothing on disk changed/)
})

test('edit: a header without a tag is a pre-write rejection', () => {
  const facts = assertDerived(editMissingTag)
  assert.equal(facts.code, 'EDIT_CONFLICT')
  assert.equal(facts.effectState, 'none')
  assert.equal(facts.retry, 'after-input-change')
})

test('edit: the seen-line refusal wrote nothing even though its text invites a retry', () => {
  const facts = assertDerived(editUnseenLines)
  assert.equal(facts.code, 'EDIT_CONFLICT')
  assert.equal(facts.effectState, 'none')
  assert.equal(facts.retry, 'after-input-change')
  assert.doesNotMatch(facts.message, /do not retry/)
})

test('edit: a replace-mode miss is a conflict over unchanged content', () => {
  const facts = assertDerived(editNoMatch)
  assert.equal(facts.code, 'EDIT_CONFLICT')
  assert.equal(facts.effectState, 'none')
})

test('write: a directory target is refused at open, so nothing was written', () => {
  const facts = assertDerived(writeDirectory)
  assert.equal(facts.code, 'IS_DIRECTORY')
  assert.equal(facts.effectState, 'none')
  assert.equal(facts.retry, 'after-input-change')
})

test('write: a read-only target is refused at open, so nothing was written', () => {
  const facts = assertDerived(writeReadOnly)
  assert.equal(facts.code, 'PATH_RESTRICTED')
  assert.equal(facts.effectState, 'none')
  assert.equal(facts.retry, 'never')
})

// ---------------------------------------------------------------- unknown effects

test('write: an unprovable failure reports unknown effect and never advises a retry', () => {
  const facts = assertDerived(writeUnknownEffect)
  assert.equal(facts.code, 'RESULT_UNKNOWN')
  assert.equal(facts.effectState, 'unknown')
  assert.equal(facts.retry, 'never')
  assert.equal(facts.status, 'unknown')
  assert.match(facts.message, /possibly modified/)
})

test('edit: an unprovable failure reports unknown effect and never advises a retry', () => {
  const facts = assertDerived(editUnknownEffect)
  assert.equal(facts.code, 'RESULT_UNKNOWN')
  assert.equal(facts.effectState, 'unknown')
  assert.equal(facts.retry, 'never')
})

test('a partially-writing edit is never called harmless: only an open can prove none', () => {
  // A failed `write` syscall (rather than a failed `open`) may have landed a prefix.
  const facts = assertDerived({
    type: 'tool_result',
    toolName: 'write',
    toolCallId: 'call_synthetic_write_partial',
    input: { path: 'big.bin', content: 'x' },
    content: [{ type: 'text', text: "EPERM: operation not permitted, write" }],
    isError: true,
  })
  assert.equal(facts.code, 'RESULT_UNKNOWN')
  assert.equal(facts.retry, 'never')
})

// ---------------------------------------------------------------- silence

test('successful read, edit and write publish nothing', () => {
  for (const raw of [readBinaryNotice, editSuccess, writeSuccess]) {
    const o = observation(raw)
    const out = run(o)
    assert.equal(out.details, o.details, 'details must be left exactly as the host sent them')
    assert.equal(out.content, o.content)
    assert.equal(out.isError, false)
    assert.equal(readOutcome(out.details), undefined)
  }
})

test('a bash observation is ignored even when it is a failure', () => {
  const raw = {
    type: 'tool_result',
    toolName: 'bash',
    toolCallId: 'call_captured_bash_exit',
    input: { command: 'echo out; exit 3', timeout: 60 },
    content: [{ type: 'text', text: 'out\n\n\nCommand exited with code 3' }],
    details: { wallTimeNoticeEmitted: false, timeoutSeconds: 60, wallTimeMs: 76.6, exitCode: 3 },
    isError: true,
  }
  const out = run(observation(raw))
  assert.equal(out.details, raw.details)
  assert.equal(readOutcome(out.details), undefined)
})

test('a grep observation is ignored', () => {
  const raw = {
    type: 'tool_result',
    toolName: 'grep',
    toolCallId: 'call_captured_grep',
    input: { pattern: 'x', path: 'scratch' },
    content: [{ type: 'text', text: 'scratch/a.txt:1:x' }],
    details: { matchCount: 1, fileCount: 1, truncated: false },
    isError: false,
  }
  const out = run(observation(raw))
  assert.equal(out.details, raw.details)
  assert.equal(readOutcome(out.details), undefined)
})

test('apply_patch and patch are not classified: the build never emitted them', () => {
  for (const tool of ['apply_patch', 'patch']) {
    const raw = {
      type: 'tool_result',
      toolName: tool,
      toolCallId: `call_synthetic_${tool}`,
      input: { patch: '*** Begin Patch\n*** End Patch' },
      content: [{ type: 'text', text: 'Patch failed: hunks did not apply' }],
      isError: true,
    }
    const out = run(observation(raw))
    assert.equal(out.details, undefined)
    assert.equal(readOutcome(out.details), undefined)
  }
})

// ---------------------------------------------------------------- publishing rules

test('an existing outcome.v1 is never overwritten', () => {
  const existing = { status: 'error', effectState: 'none', retry: 'never', message: 'kept' }
  const raw = { ...readMissing, details: { [OUTCOME_KEY]: existing, other: 1 } }
  const out = run(observation(raw))
  assert.deepEqual(out.details, { [OUTCOME_KEY]: existing, other: 1 })
})

test('publishing keeps the details another slice already wrote', () => {
  const raw = { ...editMissing, details: { resolvedPath: 'C:\\tmp\\x.txt' } }
  const out = run(observation(raw))
  const details = out.details as Record<string, unknown>
  assert.equal(details['resolvedPath'], 'C:\\tmp\\x.txt')
  const facts = readOutcome(details)
  assert.ok(facts)
  assert.equal(facts.code, 'NOT_FOUND')
})

test('frozen details are left alone rather than replaced', () => {
  const frozen = Object.freeze({})
  const out = run(observation({ ...readMissing, details: frozen }))
  assert.equal(out.details, frozen)
  assert.equal(readOutcome(out.details), undefined)
})

test('content stays byte-identical and isError is never flipped', () => {
  for (const raw of [
    readMissing,
    editMissing,
    editBinary,
    editForeignTag,
    editMissingTag,
    editUnseenLines,
    editNoMatch,
    writeDirectory,
    writeReadOnly,
    writeUnknownEffect,
    editUnknownEffect,
  ]) {
    const o = observation(raw)
    const before = JSON.stringify(o.content)
    const out = run(o)
    assert.equal(JSON.stringify(out.content), before)
    assert.equal(out.content, o.content, 'the rule must not replace the content array')
    assert.equal(out.isError, true, 'an error result must stay an error')
  }
})

test('the transform carries the pipeline identity the loader keys on', () => {
  assert.equal(transform.name, 'rules/file')
  assert.deepEqual([...transform.features], ['honesty'])
})
