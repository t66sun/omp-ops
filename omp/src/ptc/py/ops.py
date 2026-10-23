"""The PTC projection for Python cells: the same facts the honesty rules wrote, read back into a
plain ``dict``. It is a projection and never a second opinion -- ``details['outcome.v1']`` decides,
and the raw observation is only consulted when there are no facts at all.

The field names are the JavaScript helper's, deliberately: a model that learns the shape in one
language must not have to relearn it in the other. Everything crossing this boundary is JSON, so
values are plain ``dict``/``list``/``str``/``int``/``float``/``bool``/``None``.

Standard library only, and in fact no imports at all: the host bridge is handed in, never imported.
"""

__all__ = ['create_ops', 'observe', 'to_outcome']

OUTCOME_KEY = 'outcome.v1'
TOOLS = ('read', 'write', 'edit', 'glob', 'grep', 'bash', 'eval', 'task')

# A document is not a graph: past this depth a value is unreadable, so its key is dropped.
MAX_DEPTH = 256
# `Number.isSafeInteger`'s bound: a count we cannot read is a count we do not publish.
MAX_SAFE_INTEGER = 9007199254740991

EFFECT_STATES = frozenset(('none', 'applied', 'partial', 'unknown'))

# The cause of a truncation, keyed by every spelling the kernel uses for it.
TRUNCATIONS = {
    'scan-budget': 'scan-budget',
    'output-budget': 'output-budget',
    'time-limit': 'time-limit',
    'row-limit': 'row-limit',
    # `SearchExecutionReport` spells the time budget `time`; same cause, second spelling.
    'time': 'time-limit',
}

# The four legal retry advices. Anything else is not advice, so it is not carried.
RETRY_POLICIES = {
    'never': True,
    'after-input-change': True,
    'after-state-change': True,
    'bounded-transient': True,
}

# The kernel's stable codes. Copied from `src/kernel/errors.ts`, including the documented
# `EXIT_CODE` exception, because a projection that recomputed advice from a shorter table would
# silently reclassify failures the kernel has already classified.
_REJECTED = ('rejected', 'never')
_INVALID = ('error', 'after-input-change')
_CHANGED = ('error', 'after-state-change')
_SETTLED = ('error', 'never')
_UNKNOWN = ('unknown', 'never')

ERROR_POLICIES = {
    'POLICY_DENIED': _REJECTED,
    'CREDENTIAL_DENIED': _REJECTED,
    'PATH_RESTRICTED': _REJECTED,
    'REVISION_CONFLICT': ('conflict', 'after-state-change'),
    'INVALID_ARGUMENT': _INVALID,
    'EDIT_CONFLICT': _INVALID,
    'SEARCH_STALE': _INVALID,
    'NOT_FOUND': _INVALID,
    'IS_DIRECTORY': _INVALID,
    'OUTPUT_LIMIT': _INVALID,
    'CROSS_DEVICE': _INVALID,
    'ERR_INVALID_ENCODING': _INVALID,
    'TABLE_PARSE_ERROR': _INVALID,
    'DOCUMENT_PARSE_ERROR': _INVALID,
    'EXIT_CODE': _INVALID,
    'UNSUPPORTED_DOCUMENT': _SETTLED,
    'FILE_CHANGED': _CHANGED,
    'REFERENCE_EXPIRED': _CHANGED,
    'AUTHORITY_CHANGED': _CHANGED,
    'ACCESS_DENIED': _CHANGED,
    'EXECUTOR_UNAVAILABLE': _CHANGED,
    'JOB_BUSY': ('error', 'bounded-transient'),
    'CALL_LIMIT': ('error', 'after-state-change'),
    'CANCELLED': _SETTLED,
    'METADATA_UNSUPPORTED': _SETTLED,
    'LOCK_UNSUPPORTED': _SETTLED,
    'PATH_CHANGED': _CHANGED,
    'IO_ERROR': _SETTLED,
    'SYNC_FAILED': _SETTLED,
    'CLEANUP_FAILED': _SETTLED,
    'RESULT_PARTIAL': _SETTLED,
    'EXECUTION_RESTRICTED': _UNKNOWN,
    'RESULT_UNKNOWN': _UNKNOWN,
}

# `undefined` has no Python spelling, so a dropped value gets a sentinel no JSON value can be.
_DROP = object()
_INFINITY = float('inf')


def _error_policy(code, effect_state='none'):
    """Effects dominate retry advice: a failed receipt never licenses replaying a possible write."""
    if effect_state == 'unknown' or code == 'RESULT_UNKNOWN' or code == 'EXECUTION_RESTRICTED':
        return _UNKNOWN
    if effect_state != 'none':
        return _SETTLED
    return ERROR_POLICIES.get(code, _SETTLED)


def _project(value, ancestors, depth):
    """`_DROP` means "drop this key": the value cannot be represented, and a lie is worse than a gap."""
    if value is None or isinstance(value, str) or isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        # A non-finite float has no JSON spelling; a Python int has no such limit, so it is kept.
        if isinstance(value, float) and (value != value or value == _INFINITY or value == -_INFINITY):
            return _DROP
        return value
    if depth >= MAX_DEPTH or id(value) in ancestors:
        return _DROP
    ancestors.add(id(value))
    try:
        if isinstance(value, (list, tuple)):
            items = []
            for item in value:
                kept = _project(item, ancestors, depth + 1)
                if kept is not _DROP:
                    items.append(kept)
            return items
        if isinstance(value, dict):
            return _project_fields(value, ancestors, depth)
        # A set, bytes, a function or anything else has no JSON spelling, so it is dropped rather
        # than stringified into something the caller would have to guess at.
        return _DROP
    finally:
        ancestors.discard(id(value))


def _project_fields(source, ancestors, depth):
    data = {}
    for key in source:
        # The facts become typed fields below. Keeping the raw envelope too would leave two
        # statements of the same truth inside one object, free to disagree.
        if key == OUTCOME_KEY:
            continue
        # JSON keys are strings; anything else has nothing a consumer could address by name.
        if not isinstance(key, str):
            continue
        # Reading a value may itself raise (a hostile mapping); an unreadable value is a dropped key.
        try:
            raw = source[key]
        except Exception:
            continue
        kept = _project(raw, ancestors, depth + 1)
        if kept is not _DROP:
            data[key] = kept
    return data


def _data_of(observation):
    """`data` is the JSON-clean projection of the observation: the tool's own details, plus the
    identity of the call. A details value that is not a named object (a bare array, a string) has
    nothing a consumer could address by name, so only the identity survives."""
    details = observation.get('details')
    data = _project_fields(details, {id(details)}, 0) if isinstance(details, dict) else {}
    data['tool'] = observation['tool']
    call_id = observation.get('callId')
    if isinstance(call_id, str) and len(call_id) > 0:
        data['callId'] = call_id
    return data


def _count(value):
    """A count is a non-negative safe integer. `-1`, `1.5`, `'7'` and a missing field are not
    approximations of a count but unreadable data, and unreadable data reads as zero."""
    if isinstance(value, bool) or not isinstance(value, int):
        return 0
    return value if 0 <= value <= MAX_SAFE_INTEGER else 0


def _effect_state_of(value):
    """An unrecognised effect state is not a mild one: effects we cannot name we cannot bound."""
    return value if isinstance(value, str) and value in EFFECT_STATES else 'unknown'


def _coverage_of(raw):
    """Rebuilds coverage from fields we understand. `readOutcome` validates the four fields that
    decide the branch, not `coverage`, so a fact may carry counts we cannot read; those read as zero
    and an `isComplete` that is not literally `True` is not a completeness claim."""
    if not isinstance(raw, dict):
        return None
    truncated_by = raw.get('truncatedBy')
    coverage = {
        'matchedCount': _count(raw.get('matchedCount')),
        # `is True`, not truthiness: `1` is not a completeness claim in the JS helper either.
        'isComplete': raw.get('isComplete') is True,
    }
    # Absence is information: `scannedFiles` is published only when the host reports it.
    if isinstance(raw.get('scannedFiles'), (int, float)) and not isinstance(raw.get('scannedFiles'), bool):
        coverage['scannedFiles'] = _count(raw.get('scannedFiles'))
    if isinstance(truncated_by, str) and truncated_by in TRUNCATIONS:
        coverage['truncatedBy'] = TRUNCATIONS[truncated_by]
    return coverage


def _read_outcome(details):
    """Reads `details[OUTCOME_KEY]` without trusting it: any missing or wrongly-typed field makes
    the whole thing unrecognised, because a half-understood outcome is worse than none."""
    if not isinstance(details, dict):
        return None
    raw = details.get(OUTCOME_KEY)
    if not isinstance(raw, dict):
        return None
    for field in ('status', 'effectState', 'retry', 'message'):
        if not isinstance(raw.get(field), str):
            return None
    return raw


def _failure(data, code, message, effect_state, next_action=None, published_retry=None):
    """A failure is never hand-shaped: `_error_policy` owns the pair `(status, retry)`, and the
    facts supply the code and the effect state.

    `published_retry` is the one exception, and it exists because the policy cannot express it: a
    shell command that exited non-zero keeps `effectState: 'unknown'` while advising
    `after-input-change`, and the policy collapses every unknown effect to `never`. A published
    value is honoured only when it is one of the four legal advices; otherwise the policy answers.
    """
    status, retry = _error_policy(code, effect_state)
    if isinstance(published_retry, str) and RETRY_POLICIES.get(published_retry) is True:
        retry = published_retry
    error = {'code': code, 'effectState': effect_state, 'retry': retry, 'message': message}
    if next_action is not None:
        error['nextAction'] = next_action
    return {'status': status, 'error': error, 'data': data}


def _continuation_for(_tool, _args, _facts):
    """Where an incomplete observation may be continued from.

    Nothing is paginatable today. Round 1's facts carry `coverage` -- counts and a truncation cause
    -- but no cursor, so there is no fact from which the next page's start could be proven.
    Fabricating one would turn "we stopped early" into "here is the rest", which is the exact lie
    the honesty rules exist to prevent. Until a rule publishes a cursor, every tool answers `None`,
    and a `partial` fact surfaces as the kernel's "incomplete and has no safe continuation" failure.
    """
    return None


def observe(raw):
    """Maps the host payload (`toolName`, `input`) onto an observation, and returns `None` for any
    shape we do not recognise, so callers can refuse it rather than invent one. Never raises."""
    if not isinstance(raw, dict):
        return None
    tool_name = raw.get('toolName')
    content = raw.get('content')
    is_error = raw.get('isError')
    if not isinstance(tool_name, str):
        return None
    if not isinstance(content, list):
        return None
    if type(is_error) is not bool:
        return None
    observation = {
        'tool': tool_name,
        'args': raw.get('input'),
        'content': list(content),
        'details': raw.get('details'),
        'isError': is_error,
    }
    call_id = raw.get('toolCallId')
    if isinstance(call_id, str) and len(call_id) > 0:
        observation['callId'] = call_id
    return observation


def to_outcome(observation):
    """The typed projection of one observation. The order of the three cases is the contract:
    published facts first, then an unclassified failure, then a clean observation."""
    data = _data_of(observation)
    facts = _read_outcome(observation.get('details'))

    if facts is not None:
        coverage = _coverage_of(facts.get('coverage'))
        next_action = facts.get('nextAction')
        if not (isinstance(next_action, str) and len(next_action) > 0):
            next_action = None
        # `completed` with coverage that is absent or literally complete is a completion claim we
        # can carry. Coverage that says otherwise contradicts the status, and the weaker claim is
        # the true one, so the fact falls through to the incomplete path below.
        if facts['status'] == 'completed' and (coverage is None or coverage['isComplete']):
            outcome = {'status': 'completed', 'data': data}
            if coverage is not None:
                outcome['coverage'] = dict(coverage, isComplete=True)
            return outcome
        if facts['status'] == 'completed' or facts['status'] == 'partial':
            # `partial` needs recordable coverage and a continuation, because the shape says both exist.
            if coverage is not None:
                continuation = _continuation_for(observation['tool'], observation.get('args'), facts)
                if continuation is not None:
                    return {
                        'status': 'partial',
                        'data': data,
                        'coverage': dict(coverage, isComplete=False),
                        'continuation': continuation,
                    }
            return _failure(
                data,
                'RESULT_PARTIAL',
                'The observation is incomplete and has no safe continuation; refine the request instead of retrying it.',
                _effect_state_of(facts.get('effectState')),
                next_action,
                facts.get('retry'),
            )
        code = facts.get('code')
        if not (isinstance(code, str) and len(code) > 0):
            code = 'RESULT_UNKNOWN'
        return _failure(data, code, facts['message'], _effect_state_of(facts.get('effectState')), next_action, facts.get('retry'))

    if observation.get('isError') is True:
        # No rule classified this failure, which is exactly the case where no one has proven what it
        # touched: it may have written before it failed. The only honest advice for an unbounded
        # effect is `never`, so the code and the effect state are both unknown and the policy answers
        # `unknown`/`never` for us rather than us spelling it out here.
        return _failure(
            data,
            'RESULT_UNKNOWN',
            'The failure carried no outcome facts, so its effects cannot be proven; inspect the raw result before any recovery.',
            'unknown',
        )

    # Success without coverage accounting is not a claim of completeness, so there is no `coverage`
    # key: absence of evidence must not read as evidence of a full scan.
    return {'status': 'completed', 'data': data}


class _Ops:
    """One method per tool. Every one of them answers with the typed projection, never prose."""

    __slots__ = ('_await_tool',)

    def __init__(self, await_tool):
        if not callable(await_tool):
            raise TypeError('create_ops expects a callable (name, args) -> dict')
        self._await_tool = await_tool

    def _call(self, name, args):
        payload = self._await_tool(name, args)
        observation = observe(payload)
        if observation is None:
            # The bridge returned something that is not a host `tool_result`. Projecting it would
            # mean guessing at a shape the host never produced, so the mismatch is raised instead.
            raise ValueError('the tool bridge returned a payload that is not a host tool_result: %r' % (payload,))
        return to_outcome(observation)

    def read(self, args):
        return self._call('read', args)

    def write(self, args):
        return self._call('write', args)

    def edit(self, args):
        return self._call('edit', args)

    def glob(self, args):
        return self._call('glob', args)

    def grep(self, args):
        return self._call('grep', args)

    def bash(self, args):
        return self._call('bash', args)

    def eval(self, args):
        return self._call('eval', args)

    def task(self, args):
        return self._call('task', args)


def create_ops(await_tool):
    """The Python face of the SDK. `await_tool` is the one call site the host hands over: it runs a
    tool by name and returns whatever the host produced, which is projected here and nowhere else."""
    return _Ops(await_tool)
