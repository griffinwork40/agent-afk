import { createHash } from 'crypto';
import { describe, it, expect } from 'vitest';
import {
  buildToolCallStartedPayload,
  buildToolCallCompletedPayload,
  buildErrorHead,
} from './tool-call-trace.js';
import { ToolCallCompletedPayloadSchema } from '../../trace/events.js';
import type { ToolResult } from '../anthropic-direct/types.js';

describe('buildToolCallStartedPayload', () => {
  it('builds the base payload shape with subagentId omitted when undefined', () => {
    const payload = buildToolCallStartedPayload({
      toolUseId: 'tu_1',
      name: 'bash',
      input: { command: 'ls' },
    });
    expect(payload.phase).toBe('started');
    expect(payload.toolUseId).toBe('tu_1');
    expect(payload.name).toBe('bash');
    // Key must be ABSENT (not present-with-undefined) so JSONL lines stay
    // clean and readers render no orphan `[subagentId]` on root calls.
    expect('subagentId' in payload).toBe(false);
  });

  it('includes subagentId when provided', () => {
    const payload = buildToolCallStartedPayload({
      toolUseId: 'tu_2',
      name: 'search',
      input: { q: 'hello' },
      subagentId: 'research-agent-1700000000000-3',
    });
    expect('subagentId' in payload).toBe(true);
    expect(payload.subagentId).toBe('research-agent-1700000000000-3');
  });

  it('computes inputBytes as Buffer.byteLength(JSON.stringify(input), utf8) for a sample input', () => {
    const input = { q: 'hello', nested: { a: 1, b: [1, 2, 3] } };
    const payload = buildToolCallStartedPayload({
      toolUseId: 'tu_3',
      name: 'search',
      input,
    });
    expect(payload.inputBytes).toBe(Buffer.byteLength(JSON.stringify(input), 'utf8'));
    expect(payload.inputBytes).toBeGreaterThan(0);
  });

  it('computes inputBytes for undefined input as Buffer.byteLength(JSON.stringify({}))', () => {
    const payload = buildToolCallStartedPayload({
      toolUseId: 'tu_4',
      name: 'noop',
      input: undefined,
    });
    expect(payload.inputBytes).toBe(Buffer.byteLength(JSON.stringify({}), 'utf8'));
  });

  it('computes inputBytes for an empty object input', () => {
    const payload = buildToolCallStartedPayload({
      toolUseId: 'tu_5',
      name: 'noop',
      input: {},
    });
    expect(payload.inputBytes).toBe(Buffer.byteLength(JSON.stringify({}), 'utf8'));
  });

  it('computes argsFingerprint as SHA-256 hex of JSON.stringify(input)', () => {
    const input = { file_path: '/src/agent/session.ts', offset: 1, limit: 50 };
    const payload = buildToolCallStartedPayload({
      toolUseId: 'tu_fp1',
      name: 'read_file',
      input,
    });
    const expected = createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex');
    expect(payload.argsFingerprint).toBe(expected);
    expect(payload.argsFingerprint).toHaveLength(64); // SHA-256 hex = 64 chars
  });

  it('produces identical argsFingerprint for identical inputs', () => {
    const input = { file_path: '/src/foo.ts' };
    const a = buildToolCallStartedPayload({ toolUseId: 'a', name: 'read_file', input });
    const b = buildToolCallStartedPayload({ toolUseId: 'b', name: 'read_file', input });
    expect(a.argsFingerprint).toBe(b.argsFingerprint);
  });

  it('produces different argsFingerprint for different inputs', () => {
    const a = buildToolCallStartedPayload({
      toolUseId: 'a', name: 'read_file', input: { file_path: '/src/a.ts' },
    });
    const b = buildToolCallStartedPayload({
      toolUseId: 'b', name: 'read_file', input: { file_path: '/src/b.ts' },
    });
    expect(a.argsFingerprint).not.toBe(b.argsFingerprint);
  });

  it('argsFingerprint for undefined input matches empty-object hash', () => {
    const payload = buildToolCallStartedPayload({
      toolUseId: 'tu_und',
      name: 'noop',
      input: undefined,
    });
    const expected = createHash('sha256').update(JSON.stringify({})).digest('hex');
    expect(payload.argsFingerprint).toBe(expected);
  });

  it('redacts browser_act fill value from argsFingerprint (security)', () => {
    const secret = 'my-super-secret-password-123';
    const input = { action: 'fill', target: { kind: 'selector', selector: '#pw' }, value: secret };
    const payload = buildToolCallStartedPayload({
      toolUseId: 'tu_sec',
      name: 'browser_act',
      input,
    });
    // The hash must NOT be derivable from the secret — it should match the
    // redacted version instead.
    const redacted = { ...input, value: '[REDACTED]' };
    const expectedHash = createHash('sha256').update(JSON.stringify(redacted)).digest('hex');
    expect(payload.argsFingerprint).toBe(expectedHash);

    // And must NOT match a hash of the raw input.
    const rawHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    expect(payload.argsFingerprint).not.toBe(rawHash);
  });

  it('does not redact browser_act non-fill actions', () => {
    const input = { action: 'click', target: { kind: 'selector', selector: '#btn' } };
    const payload = buildToolCallStartedPayload({
      toolUseId: 'tu_click',
      name: 'browser_act',
      input,
    });
    const expected = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    expect(payload.argsFingerprint).toBe(expected);
  });

  it('does not redact non-browser_act tools', () => {
    const input = { command: 'echo secret', value: 'should-not-be-touched' };
    const payload = buildToolCallStartedPayload({
      toolUseId: 'tu_bash',
      name: 'bash',
      input,
    });
    const expected = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    expect(payload.argsFingerprint).toBe(expected);
  });

  it('redacts config_set value when target=env (security)', () => {
    const input = { target: 'env', key: 'SOME_SECRET', value: 'sk-live-abc123', action: 'set' };
    const payload = buildToolCallStartedPayload({
      toolUseId: 'tu_cfg1',
      name: 'config_set',
      input,
    });
    // inputBytes uses RAW input — must include the real value length.
    expect(payload.inputBytes).toBe(Buffer.byteLength(JSON.stringify(input), 'utf8'));
    // Fingerprint must NOT match a hash of the raw input (secret is redacted).
    const rawHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    expect(payload.argsFingerprint).not.toBe(rawHash);
    // Stable: two calls with the same input produce the same fingerprint.
    const p2 = buildToolCallStartedPayload({ toolUseId: 'tu_cfg2', name: 'config_set', input });
    expect(payload.argsFingerprint).toBe(p2.argsFingerprint);
  });

  it('does not redact config_set with target=config (non-secret keys)', () => {
    const input = { target: 'config', key: 'temperature', value: 0.7, action: 'set' };
    const payload = buildToolCallStartedPayload({
      toolUseId: 'tu_cfg3',
      name: 'config_set',
      input,
    });
    const expected = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    expect(payload.argsFingerprint).toBe(expected);
  });

  it('does not redact config_set unset action (no value field)', () => {
    const input = { target: 'env', key: 'SOME_VAR', action: 'unset' };
    const payload = buildToolCallStartedPayload({
      toolUseId: 'tu_cfg4',
      name: 'config_set',
      input,
    });
    const expected = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    expect(payload.argsFingerprint).toBe(expected);
  });

  // ── resourceFingerprint ─────────────────────────────────────────────────

  it('computes resourceFingerprint for read_file from file_path alone (ignoring offset/limit)', () => {
    const a = buildToolCallStartedPayload({
      toolUseId: 'rf_a', name: 'read_file',
      input: { file_path: '/src/agent/session.ts', offset: 1, limit: 50 },
    });
    const b = buildToolCallStartedPayload({
      toolUseId: 'rf_b', name: 'read_file',
      input: { file_path: '/src/agent/session.ts', offset: 100, limit: 200 },
    });
    expect(a.resourceFingerprint).toBeDefined();
    expect(a.resourceFingerprint).toHaveLength(64);
    // Same file, different offsets → same resourceFingerprint
    expect(a.resourceFingerprint).toBe(b.resourceFingerprint);
    // But different argsFingerprint (offset/limit differ)
    expect(a.argsFingerprint).not.toBe(b.argsFingerprint);
  });

  it('produces different resourceFingerprint for different read_file paths', () => {
    const a = buildToolCallStartedPayload({
      toolUseId: 'rf_c', name: 'read_file',
      input: { file_path: '/src/a.ts' },
    });
    const b = buildToolCallStartedPayload({
      toolUseId: 'rf_d', name: 'read_file',
      input: { file_path: '/src/b.ts' },
    });
    expect(a.resourceFingerprint).not.toBe(b.resourceFingerprint);
  });

  it('does not include resourceFingerprint for non-resource tools (bash, agent, etc.)', () => {
    const bash = buildToolCallStartedPayload({
      toolUseId: 'nr_1', name: 'bash',
      input: { command: 'ls' },
    });
    expect('resourceFingerprint' in bash).toBe(false);

    const agent = buildToolCallStartedPayload({
      toolUseId: 'nr_2', name: 'agent',
      input: { prompt: 'investigate' },
    });
    expect('resourceFingerprint' in agent).toBe(false);
  });

  it('does not include resourceFingerprint for glob tool calls', () => {
    // glob is a filesystem tool but has no single named resource that maps
    // cleanly to a dedup key (pattern + base dir combo is not equivalent to
    // a file identity), so resourceFingerprint must be absent.
    const payload = buildToolCallStartedPayload({
      toolUseId: 'gl_1', name: 'glob',
      input: { pattern: 'src/**/*.ts', path: '/src' },
    });
    expect('resourceFingerprint' in payload).toBe(false);
  });

  it('normalizes trailing slashes and consecutive slashes in read_file paths', () => {
    const clean = buildToolCallStartedPayload({
      toolUseId: 'norm_a', name: 'read_file',
      input: { file_path: '/src/agent/session.ts' },
    });
    const messy = buildToolCallStartedPayload({
      toolUseId: 'norm_b', name: 'read_file',
      input: { file_path: '/src//agent///session.ts' },
    });
    expect(clean.resourceFingerprint).toBe(messy.resourceFingerprint);
  });

  it('computes resourceFingerprint for list_directory from path', () => {
    const payload = buildToolCallStartedPayload({
      toolUseId: 'ld_1', name: 'list_directory',
      input: { path: '/src/agent/' },
    });
    expect(payload.resourceFingerprint).toBeDefined();
    expect(payload.resourceFingerprint).toHaveLength(64);
    // Trailing slash stripped in normalization
    const payload2 = buildToolCallStartedPayload({
      toolUseId: 'ld_2', name: 'list_directory',
      input: { path: '/src/agent' },
    });
    expect(payload.resourceFingerprint).toBe(payload2.resourceFingerprint);
  });

  it('computes resourceFingerprint for grep from path', () => {
    const payload = buildToolCallStartedPayload({
      toolUseId: 'gr_1', name: 'grep',
      input: { pattern: 'foo', path: '/src/agent' },
    });
    expect(payload.resourceFingerprint).toBeDefined();
    expect(payload.resourceFingerprint).toHaveLength(64);
  });

  it('produces different resourceFingerprint for grep with different include args (#1565)', () => {
    // Two greps on the same directory with different file-glob filters read
    // entirely different files — they must NOT share a resource fingerprint.
    const ts = buildToolCallStartedPayload({
      toolUseId: 'gr_inc_ts', name: 'grep',
      input: { pattern: 'foo', path: '/src', include: '*.ts' },
    });
    const py = buildToolCallStartedPayload({
      toolUseId: 'gr_inc_py', name: 'grep',
      input: { pattern: 'foo', path: '/src', include: '*.py' },
    });
    expect(ts.resourceFingerprint).toBeDefined();
    expect(py.resourceFingerprint).toBeDefined();
    expect(ts.resourceFingerprint).not.toBe(py.resourceFingerprint);
  });

  it('produces identical resourceFingerprint for grep with same include arg', () => {
    const a = buildToolCallStartedPayload({
      toolUseId: 'gr_same_a', name: 'grep',
      input: { pattern: 'bar', path: '/src', include: '*.ts' },
    });
    const b = buildToolCallStartedPayload({
      toolUseId: 'gr_same_b', name: 'grep',
      input: { pattern: 'baz', path: '/src', include: '*.ts' },
    });
    // Same path + same include → same resource (different patterns still scan
    // identical files; only `path` and `include` define the resource scope).
    expect(a.resourceFingerprint).toBe(b.resourceFingerprint);
  });

  it('produces identical resourceFingerprint for grep with and without absent include', () => {
    // Omitting `include` is equivalent to no filter — both should hash path only.
    const withoutInclude = buildToolCallStartedPayload({
      toolUseId: 'gr_no_inc', name: 'grep',
      input: { pattern: 'foo', path: '/src/agent' },
    });
    const emptyInclude = buildToolCallStartedPayload({
      toolUseId: 'gr_empty_inc', name: 'grep',
      input: { pattern: 'foo', path: '/src/agent', include: '' },
    });
    expect(withoutInclude.resourceFingerprint).toBe(emptyInclude.resourceFingerprint);
  });

  it('omits resourceFingerprint for read_file with missing/empty file_path', () => {
    const noPath = buildToolCallStartedPayload({
      toolUseId: 'rf_e', name: 'read_file', input: {},
    });
    expect('resourceFingerprint' in noPath).toBe(false);

    const empty = buildToolCallStartedPayload({
      toolUseId: 'rf_f', name: 'read_file', input: { file_path: '' },
    });
    expect('resourceFingerprint' in empty).toBe(false);
  });
});

describe('buildToolCallCompletedPayload', () => {
  const baseResult: ToolResult = { content: 'ok', isError: false };

  it('builds the base payload shape', () => {
    const payload = buildToolCallCompletedPayload({
      toolUseId: 'tu_1',
      name: 'bash',
      result: baseResult,
      truncated: false,
      durationMs: 42,
    });
    expect(payload.phase).toBe('completed');
    expect(payload.toolUseId).toBe('tu_1');
    expect(payload.name).toBe('bash');
    expect(payload.resultBytes).toBe(Buffer.byteLength('ok', 'utf8'));
    expect(payload.isError).toBe(false);
    expect(payload.truncated).toBe(false);
    expect(payload.durationMs).toBe(42);
  });

  it('sets isError true when result.isError is true', () => {
    const payload = buildToolCallCompletedPayload({
      toolUseId: 'tu_err',
      name: 'bash',
      result: { content: 'boom', isError: true },
      truncated: false,
      durationMs: 5,
    });
    expect(payload.isError).toBe(true);
  });

  it('sets isError false when result.isError is false or absent', () => {
    const payload1 = buildToolCallCompletedPayload({
      toolUseId: 'tu_a',
      name: 'bash',
      result: { content: 'ok', isError: false },
      truncated: false,
      durationMs: 1,
    });
    const payload2 = buildToolCallCompletedPayload({
      toolUseId: 'tu_b',
      name: 'bash',
      result: { content: 'ok' },
      truncated: false,
      durationMs: 1,
    });
    expect(payload1.isError).toBe(false);
    expect(payload2.isError).toBe(false);
  });

  it('passes truncated and durationMs through unchanged (does not recompute them)', () => {
    const payload = buildToolCallCompletedPayload({
      toolUseId: 'tu_t',
      name: 'bash',
      // Content has no truncation sentinel and no structured flag — proves
      // the builder trusts the passed-in `truncated` rather than deriving it.
      result: { content: 'clean output, nothing truncated here' },
      truncated: true,
      durationMs: 987,
    });
    expect(payload.truncated).toBe(true);
    expect(payload.durationMs).toBe(987);
  });

  it('spreads incomplete/incompleteReason only when result carries them', () => {
    const withIncomplete = buildToolCallCompletedPayload({
      toolUseId: 'tu_inc',
      name: 'agent',
      result: { content: 'partial', incomplete: true, incompleteReason: 'tool_use_loop_capped' },
      truncated: false,
      durationMs: 1,
    });
    expect(withIncomplete.incomplete).toBe(true);
    expect(withIncomplete.incompleteReason).toBe('tool_use_loop_capped');

    // Clean ToolResult: both keys ABSENT (not present-with-falsy), matching
    // the omit-when-absent idiom used by circuitBreaker/failureClass below.
    const clean = buildToolCallCompletedPayload({
      toolUseId: 'tu_clean',
      name: 'agent',
      result: baseResult,
      truncated: false,
      durationMs: 1,
    });
    expect('incomplete' in clean).toBe(false);
    expect('incompleteReason' in clean).toBe(false);

    const falseIncomplete = buildToolCallCompletedPayload({
      toolUseId: 'tu_false_inc',
      name: 'agent',
      result: { content: 'x', incomplete: false },
      truncated: false,
      durationMs: 1,
    });
    expect('incomplete' in falseIncomplete).toBe(false);
  });

  it('spreads circuitBreaker only when result.circuitBreaker === true', () => {
    const withBreaker = buildToolCallCompletedPayload({
      toolUseId: 'tu_cb',
      name: 'bash',
      result: { content: 'x', circuitBreaker: true },
      truncated: false,
      durationMs: 1,
    });
    expect(withBreaker.circuitBreaker).toBe(true);

    const withoutBreaker = buildToolCallCompletedPayload({
      toolUseId: 'tu_no_cb',
      name: 'bash',
      result: { content: 'x' },
      truncated: false,
      durationMs: 1,
    });
    expect('circuitBreaker' in withoutBreaker).toBe(false);

    const falseBreaker = buildToolCallCompletedPayload({
      toolUseId: 'tu_false_cb',
      name: 'bash',
      result: { content: 'x', circuitBreaker: false },
      truncated: false,
      durationMs: 1,
    });
    expect('circuitBreaker' in falseBreaker).toBe(false);
  });

  it('spreads failureClass only when set', () => {
    const withClass = buildToolCallCompletedPayload({
      toolUseId: 'tu_fc',
      name: 'bash',
      result: { content: 'x', isError: true, failureClass: 'timeout' },
      truncated: false,
      durationMs: 1,
    });
    expect(withClass.failureClass).toBe('timeout');

    const withoutClass = buildToolCallCompletedPayload({
      toolUseId: 'tu_no_fc',
      name: 'bash',
      result: { content: 'x', isError: true },
      truncated: false,
      durationMs: 1,
    });
    expect('failureClass' in withoutClass).toBe(false);
  });

  it('spreads batchIndex/batchSize only when BOTH are numbers', () => {
    const both = buildToolCallCompletedPayload({
      toolUseId: 'tu_batch',
      name: 'bash',
      result: { content: 'x', batchIndex: 1, batchSize: 3 },
      truncated: false,
      durationMs: 1,
    });
    expect(both.batchIndex).toBe(1);
    expect(both.batchSize).toBe(3);

    const onlyIndex = buildToolCallCompletedPayload({
      toolUseId: 'tu_only_idx',
      name: 'bash',
      result: { content: 'x', batchIndex: 1 },
      truncated: false,
      durationMs: 1,
    });
    expect('batchIndex' in onlyIndex).toBe(false);
    expect('batchSize' in onlyIndex).toBe(false);

    const onlySize = buildToolCallCompletedPayload({
      toolUseId: 'tu_only_size',
      name: 'bash',
      result: { content: 'x', batchSize: 3 },
      truncated: false,
      durationMs: 1,
    });
    expect('batchIndex' in onlySize).toBe(false);
    expect('batchSize' in onlySize).toBe(false);

    const neither = buildToolCallCompletedPayload({
      toolUseId: 'tu_neither',
      name: 'bash',
      result: { content: 'x' },
      truncated: false,
      durationMs: 1,
    });
    expect('batchIndex' in neither).toBe(false);
    expect('batchSize' in neither).toBe(false);
  });

  it('includes subagentId when provided, omits it when undefined', () => {
    const withId = buildToolCallCompletedPayload({
      toolUseId: 'tu_sub',
      name: 'bash',
      result: { content: 'x' },
      truncated: false,
      durationMs: 1,
      subagentId: 'research-agent-1700000000000-3',
    });
    expect('subagentId' in withId).toBe(true);
    expect(withId.subagentId).toBe('research-agent-1700000000000-3');

    const withoutId = buildToolCallCompletedPayload({
      toolUseId: 'tu_no_sub',
      name: 'bash',
      result: { content: 'x' },
      truncated: false,
      durationMs: 1,
    });
    expect('subagentId' in withoutId).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildErrorHead
// ---------------------------------------------------------------------------

describe('buildErrorHead', () => {
  it('returns undefined for a successful call (isError=false)', () => {
    expect(buildErrorHead(false, 'some output')).toBeUndefined();
  });

  it('returns undefined for an error call with empty content', () => {
    expect(buildErrorHead(true, '')).toBeUndefined();
  });

  it('returns undefined for an error call with whitespace-only content', () => {
    expect(buildErrorHead(true, '   \n\t  ')).toBeUndefined();
  });

  it('returns the content unchanged (beyond redaction) when it fits within 200 chars', () => {
    const content = 'Error: file not found at /src/foo.ts';
    const head = buildErrorHead(true, content);
    expect(head).toBe(content);
  });

  it('collapses newlines to spaces', () => {
    const head = buildErrorHead(true, 'line one\nline two\r\nline three\rline four');
    expect(head).toBe('line one line two line three line four');
  });

  it('trims surrounding whitespace after newline collapse', () => {
    const head = buildErrorHead(true, '\n  error message  \n');
    expect(head).toBe('error message');
  });

  it('truncates at 200 chars and appends truncation marker', () => {
    // Build a realistic-looking error that is >200 chars and won't match any
    // redaction rule (no long opaque blobs, no known token prefixes).
    const word = 'Error at path ';
    const repeated = (word + '/src/some/file.ts: line does not match ').repeat(10);
    expect(repeated.length).toBeGreaterThan(200);
    const head = buildErrorHead(true, repeated);
    expect(head).toBeDefined();
    expect(head!.endsWith('… (truncated)')).toBe(true);
    // The slice before the marker must be exactly 200 chars (code points).
    const markerLen = '… (truncated)'.length;
    expect(head!.slice(0, head!.length - markerLen)).toHaveLength(200);
  });

  it('does NOT append truncation marker when content is exactly 200 chars', () => {
    // Use a word that repeats cleanly to hit exactly 200 chars without
    // triggering the generic opaque-token redaction rule (no 32+ char blobs).
    const word = 'error '; // 6 chars
    const exact = (word.repeat(33) + 'end').slice(0, 200);
    expect(exact).toHaveLength(200);
    const head = buildErrorHead(true, exact);
    expect(head).toBe(exact);
    expect(head).not.toContain('(truncated)');
  });

  it('redacts an Anthropic API key (sk-ant-…)', () => {
    const key = 'sk-ant-api03-' + 'A'.repeat(40);
    const content = `Error: invalid key ${key} provided`;
    const head = buildErrorHead(true, content);
    expect(head).toBeDefined();
    expect(head).not.toContain(key);
    expect(head).toContain('[REDACTED]');
  });

  it('redacts a GitHub PAT (ghp_…) via the generic long-token rule', () => {
    // ghp_ tokens are 40 chars (prefix + 36 base62 chars) — caught by
    // the generic ≥32-char opaque token rule in redactSecrets.
    const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7';
    const content = `fatal: Authentication failed: ${token}`;
    const head = buildErrorHead(true, content);
    expect(head).toBeDefined();
    expect(head).not.toContain(token);
    expect(head).toContain('[REDACTED]');
  });

  it('redacts a Bearer token', () => {
    const content = 'Authorization: Bearer mysupersecrettokenvalue1234567890 not allowed';
    const head = buildErrorHead(true, content);
    expect(head).toBeDefined();
    expect(head).toContain('[REDACTED]');
    expect(head).not.toContain('mysupersecrettokenvalue');
  });

  it('preserves non-secret content without altering it', () => {
    const content = 'edit_file: old_string not found in /Users/me/project/src/foo.ts';
    const head = buildErrorHead(true, content);
    expect(head).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// errorHead integration: buildToolCallCompletedPayload
// ---------------------------------------------------------------------------

describe('buildToolCallCompletedPayload — errorHead field', () => {
  it('includes errorHead on a failed call with non-empty content', () => {
    const payload = buildToolCallCompletedPayload({
      toolUseId: 'tu_eh1',
      name: 'edit_file',
      result: { content: 'old_string not found in file', isError: true },
      truncated: false,
      durationMs: 5,
    });
    expect('errorHead' in payload).toBe(true);
    expect(payload.errorHead).toBe('old_string not found in file');
  });

  it('omits errorHead on a successful call', () => {
    const payload = buildToolCallCompletedPayload({
      toolUseId: 'tu_eh2',
      name: 'bash',
      result: { content: 'hello world', isError: false },
      truncated: false,
      durationMs: 1,
    });
    expect('errorHead' in payload).toBe(false);
  });

  it('omits errorHead when error content is empty', () => {
    const payload = buildToolCallCompletedPayload({
      toolUseId: 'tu_eh3',
      name: 'bash',
      result: { content: '', isError: true },
      truncated: false,
      durationMs: 1,
    });
    expect('errorHead' in payload).toBe(false);
  });

  it('redacts a secret in the error head', () => {
    const key = 'sk-ant-api03-' + 'B'.repeat(40);
    const payload = buildToolCallCompletedPayload({
      toolUseId: 'tu_eh_redact',
      name: 'bash',
      result: { content: `Error: invalid key ${key}`, isError: true },
      truncated: false,
      durationMs: 1,
    });
    expect(payload.errorHead).toBeDefined();
    expect(payload.errorHead).not.toContain(key);
    expect(payload.errorHead).toContain('[REDACTED]');
  });

  it('collapses newlines in the error head', () => {
    const payload = buildToolCallCompletedPayload({
      toolUseId: 'tu_eh_nl',
      name: 'bash',
      result: { content: 'line1\nline2\r\nline3', isError: true },
      truncated: false,
      durationMs: 1,
    });
    expect(payload.errorHead).toBe('line1 line2 line3');
  });
});

// ---------------------------------------------------------------------------
// Schema: ToolCallCompletedPayloadSchema accepts/rejects errorHead
// ---------------------------------------------------------------------------

describe('ToolCallCompletedPayloadSchema — errorHead', () => {
  const base = {
    phase: 'completed' as const,
    toolUseId: 'tu_s1',
    name: 'bash',
    resultBytes: 4,
    isError: false,
    truncated: false,
    durationMs: 10,
  };

  it('validates a payload WITHOUT errorHead (backward compat)', () => {
    const result = ToolCallCompletedPayloadSchema.safeParse(base);
    expect(result.success).toBe(true);
  });

  it('validates a payload WITH errorHead present', () => {
    const result = ToolCallCompletedPayloadSchema.safeParse({
      ...base,
      isError: true,
      errorHead: 'old_string not found',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.errorHead).toBe('old_string not found');
  });

  it('rejects a payload where errorHead is not a string', () => {
    const result = ToolCallCompletedPayloadSchema.safeParse({
      ...base,
      isError: true,
      errorHead: 42,
    });
    expect(result.success).toBe(false);
  });
});
