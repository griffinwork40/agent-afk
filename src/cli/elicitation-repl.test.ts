/**
 * Tests for the REPL-backed elicitation handler.
 *
 * The handler is invoked when the SDK routes an elicitation through
 * `elicitationRouter.route()` and a REPL handler is installed. Input is
 * collected from a configurable `readLine` function (so we can unit-test
 * without touching real stdin) and output is captured via an injected
 * writer.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ElicitationRequest } from '../agent/types/sdk-types.js';
import { makeReplElicitationHandler } from './elicitation-repl.js';

const NO_SIGNAL = new AbortController().signal;

function urlRequest(overrides: Partial<ElicitationRequest> = {}): ElicitationRequest {
  return {
    serverName: 'supabase',
    message: 'Sign in to continue',
    mode: 'url',
    url: 'https://supabase.example/oauth/abc',
    elicitationId: 'el-1',
    ...overrides,
  };
}

function formRequest(
  schema?: Record<string, unknown>,
  required?: string[],
): ElicitationRequest {
  return {
    serverName: 'some-mcp',
    message: 'Provide your API key',
    mode: 'form',
    requestedSchema: schema
      ? { type: 'object', properties: schema, ...(required ? { required } : {}) }
      : undefined,
  };
}

describe('makeReplElicitationHandler', () => {
  it('renders a URL elicitation with visible URL and captures y/n confirmation', async () => {
    const lines: string[] = [];
    const reader = vi.fn().mockResolvedValue('y');
    const handler = makeReplElicitationHandler({
      readLine: reader,
      writer: { line: (t = '') => lines.push(t) },
        pendingCount: () => 0,
    });

    const result = await handler(urlRequest(), { signal: NO_SIGNAL });
    expect(result.action).toBe('accept');
    const joined = lines.join('\n');
    expect(joined).toMatch(/supabase/);
    expect(joined).toMatch(/Sign in to continue/);
    expect(joined).toMatch(/https:\/\/supabase\.example\/oauth\/abc/);
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it('declines when user replies "n"', async () => {
    const handler = makeReplElicitationHandler({
      readLine: vi.fn().mockResolvedValue('n'),
      writer: { line: vi.fn() },
        pendingCount: () => 0,
    });
    const result = await handler(urlRequest(), { signal: NO_SIGNAL });
    expect(result.action).toBe('decline');
  });

  it('treats empty reply as cancel', async () => {
    const handler = makeReplElicitationHandler({
      readLine: vi.fn().mockResolvedValue(''),
      writer: { line: vi.fn() },
        pendingCount: () => 0,
    });
    const result = await handler(urlRequest(), { signal: NO_SIGNAL });
    expect(result.action).toBe('cancel');
  });

  it('respects an aborted signal by declining without prompting', async () => {
    const reader = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const handler = makeReplElicitationHandler({
      readLine: reader,
      writer: { line: vi.fn() },
        pendingCount: () => 0,
    });
    const result = await handler(urlRequest(), { signal: controller.signal });
    expect(result.action).toBe('decline');
    expect(reader).not.toHaveBeenCalled();
  });

  // Issue #502 F1: URL mode was the ONLY elicitation path with no try/catch
  // around its readLine await — a rejection (Ctrl+C, session teardown mid-
  // prompt) propagated out of the handler and was reinterpreted as DECLINE
  // by the router's outer `.catch(() => DECLINE)` (elicitation-router.ts)
  // instead of CANCEL like every other path in this module. Before the fix
  // this test failed with an unhandled rejection, not a wrong assertion.
  it('maps a readLine rejection to cancel — matches every other elicitation path (#502 F1)', async () => {
    const reader = vi.fn().mockRejectedValue(new Error('SIGINT'));
    const handler = makeReplElicitationHandler({
      readLine: reader,
      writer: { line: vi.fn() },
      pendingCount: () => 0,
    });
    const result = await handler(urlRequest(), { signal: NO_SIGNAL });
    expect(result.action).toBe('cancel');
  });

  // Issue #502 F2: the rejection above is still swallowed as far as the
  // caller's return value is concerned (CANCEL is the correct, safe outcome
  // either way) — but it must no longer be INVISIBLE. Under AFK_DEBUG=1 the
  // underlying error is now observable, distinguishing a genuine dependency
  // failure from a plain user cancel.
  it('logs the underlying error via debugLog under AFK_DEBUG=1 (#502 F2)', async () => {
    const prevDebug = process.env['AFK_DEBUG'];
    process.env['AFK_DEBUG'] = '1';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const reader = vi.fn().mockRejectedValue(new Error('boom'));
      const handler = makeReplElicitationHandler({
        readLine: reader,
        writer: { line: vi.fn() },
        pendingCount: () => 0,
      });
      const result = await handler(urlRequest(), { signal: NO_SIGNAL });
      expect(result.action).toBe('cancel');
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('[elicitation]'),
        expect.objectContaining({ message: 'boom' }),
      );
    } finally {
      logSpy.mockRestore();
      if (prevDebug === undefined) delete process.env['AFK_DEBUG'];
      else process.env['AFK_DEBUG'] = prevDebug;
    }
  });

  describe('form mode', () => {
    // SC1: accept happy path — all three field types coerced correctly
    it('collects string, number, and boolean fields and returns accept', async () => {
      const lines: string[] = [];
      const reader = vi
        .fn()
        .mockResolvedValueOnce('my-secret')   // apiKey (string)
        .mockResolvedValueOnce('5')            // count (number)
        .mockResolvedValueOnce('y');           // enabled (boolean)

      const handler = makeReplElicitationHandler({
        readLine: reader,
        writer: { line: (t = '') => lines.push(t) },
        pendingCount: () => 0,
      });

      const result = await handler(
        formRequest(
          {
            apiKey:  { type: 'string',  description: 'Your API key' },
            count:   { type: 'number',  description: 'How many' },
            enabled: { type: 'boolean', description: 'Enabled?' },
          },
          ['apiKey', 'count', 'enabled'],
        ),
        { signal: NO_SIGNAL },
      );

      expect(result.action).toBe('accept');
      expect(result.content?.['apiKey']).toBe('my-secret');
      expect(result.content?.['count']).toBe(5);
      expect(result.content?.['enabled']).toBe(true);
    });

    // SC2: :decline at prompt → returns decline without finishing remaining fields
    it('returns decline when user types :decline at any prompt', async () => {
      const reader = vi.fn().mockResolvedValue(':decline');
      const handler = makeReplElicitationHandler({
        readLine: reader,
        writer: { line: vi.fn() },
        pendingCount: () => 0,
      });

      const result = await handler(
        formRequest({ name: { type: 'string' }, extra: { type: 'string' } }),
        { signal: NO_SIGNAL },
      );

      expect(result.action).toBe('decline');
      // Should bail on first field — reader called once, not twice
      expect(reader).toHaveBeenCalledTimes(1);
    });

    // SC3a: :cancel at prompt → returns cancel
    it('returns cancel when user types :cancel at any prompt', async () => {
      const reader = vi.fn().mockResolvedValue(':cancel');
      const handler = makeReplElicitationHandler({
        readLine: reader,
        writer: { line: vi.fn() },
        pendingCount: () => 0,
      });

      const result = await handler(
        formRequest({ token: { type: 'string' } }),
        { signal: NO_SIGNAL },
      );

      expect(result.action).toBe('cancel');
    });

    // SC3b: readLine rejection (e.g. SIGINT) → returns cancel, does not throw
    it('maps readLine rejection to cancel action', async () => {
      const reader = vi.fn().mockRejectedValue(new Error('SIGINT'));
      const handler = makeReplElicitationHandler({
        readLine: reader,
        writer: { line: vi.fn() },
        pendingCount: () => 0,
      });

      const result = await handler(
        formRequest({ token: { type: 'string' } }),
        { signal: NO_SIGNAL },
      );

      expect(result.action).toBe('cancel');
    });

    // Issue #502 F2: the same swallowed-error observability gap existed in
    // form mode's readLine catch. Verify the pattern was applied here too,
    // not just in url-mode.
    it('logs the underlying readLine error via debugLog under AFK_DEBUG=1 (#502 F2)', async () => {
      const prevDebug = process.env['AFK_DEBUG'];
      process.env['AFK_DEBUG'] = '1';
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const reader = vi.fn().mockRejectedValue(new Error('dependency exploded'));
        const handler = makeReplElicitationHandler({
          readLine: reader,
          writer: { line: vi.fn() },
          pendingCount: () => 0,
        });
        const result = await handler(
          formRequest({ token: { type: 'string' } }),
          { signal: NO_SIGNAL },
        );
        expect(result.action).toBe('cancel');
        expect(logSpy).toHaveBeenCalledWith(
          expect.stringContaining('[elicitation]'),
          expect.objectContaining({ message: 'dependency exploded' }),
        );
      } finally {
        logSpy.mockRestore();
        if (prevDebug === undefined) delete process.env['AFK_DEBUG'];
        else process.env['AFK_DEBUG'] = prevDebug;
      }
    });

    // SC4: optional-field skip — empty enter omits field, loop continues
    it('skips optional fields when user presses enter with no input', async () => {
      const reader = vi
        .fn()
        .mockResolvedValueOnce('')        // first (optional) — skip
        .mockResolvedValueOnce('hello');  // second (optional) — fill

      const handler = makeReplElicitationHandler({
        readLine: reader,
        writer: { line: vi.fn() },
        pendingCount: () => 0,
      });

      const result = await handler(
        formRequest({
          first:  { type: 'string', description: 'First field' },
          second: { type: 'string', description: 'Second field' },
        }),
        // No required array → both optional
        { signal: NO_SIGNAL },
      );

      expect(result.action).toBe('accept');
      expect(result.content).not.toHaveProperty('first');
      expect(result.content?.['second']).toBe('hello');
    });

    // SC5: enum validation — bad value triggers re-prompt; good value accepted
    it('rejects values not in enum and re-prompts with a warning', async () => {
      const lines: string[] = [];
      const reader = vi
        .fn()
        .mockResolvedValueOnce('superuser')  // invalid
        .mockResolvedValueOnce('read');       // valid

      const handler = makeReplElicitationHandler({
        readLine: reader,
        writer: { line: (t = '') => lines.push(t) },
        pendingCount: () => 0,
      });

      const result = await handler(
        formRequest({ role: { type: 'string', enum: ['read', 'write', 'admin'] } }),
        { signal: NO_SIGNAL },
      );

      expect(result.action).toBe('accept');
      expect(result.content?.['role']).toBe('read');
      const joined = lines.join('\n');
      // Warning should mention the invalid input or the valid options
      expect(joined).toMatch(/superuser|valid|read.*write.*admin/i);
    });

    // SC6: required-field re-prompt — empty required field → warning → second attempt
    it('re-prompts and warns when a required field is left empty', async () => {
      const lines: string[] = [];
      const reader = vi
        .fn()
        .mockResolvedValueOnce('')        // empty → should warn and re-prompt
        .mockResolvedValueOnce('filled'); // valid

      const handler = makeReplElicitationHandler({
        readLine: reader,
        writer: { line: (t = '') => lines.push(t) },
        pendingCount: () => 0,
      });

      const result = await handler(
        formRequest({ name: { type: 'string' } }, ['name']),
        { signal: NO_SIGNAL },
      );

      expect(result.action).toBe('accept');
      expect(result.content?.['name']).toBe('filled');
      expect(lines.join('\n')).toMatch(/required/i);
    });

    // SC7: unknown type warning — emitted once, value collected as string
    it('warns about unknown field type and still collects value as string', async () => {
      const lines: string[] = [];
      const reader = vi.fn().mockResolvedValue('some-uuid-value');

      const handler = makeReplElicitationHandler({
        readLine: reader,
        writer: { line: (t = '') => lines.push(t) },
        pendingCount: () => 0,
      });

      const result = await handler(
        formRequest({ id: { type: 'uuid' } }),
        { signal: NO_SIGNAL },
      );

      expect(result.action).toBe('accept');
      expect(result.content?.['id']).toBe('some-uuid-value');
      // Warning must mention the unknown type
      expect(lines.join('\n')).toMatch(/uuid/i);
      // Warning should only be emitted once (not on every loop iteration)
      expect(reader).toHaveBeenCalledTimes(1);
    });

    // SC8: malformed schema (no properties / no schema) → decline.
    // Previously this path returned `{ action: 'accept', content: { response: <text> } }`
    // with an invented `response` key not in the MCP spec. The current
    // contract declines: form-mode with no fields is unresolvable, and
    // inventing a key risks server-side schema rejection.
    it('declines when schema has no usable properties (without prompting)', async () => {
      const reader = vi.fn();
      const lines: string[] = [];
      const handler = makeReplElicitationHandler({
        readLine: reader,
        writer: { line: (t = '') => lines.push(t) },
        pendingCount: () => 0,
      });

      const result = await handler(formRequest(), { signal: NO_SIGNAL });

      expect(result.action).toBe('decline');
      // Must not prompt the user — the schema is unresolvable a priori
      expect(reader).not.toHaveBeenCalled();
      // Should surface a user-visible warning explaining why
      expect(lines.join('\n')).toMatch(/no usable fields|declining/i);
    });

    // SC9: required key absent from properties → decline before prompting
    it('declines when a required key has no schema entry in properties', async () => {
      const reader = vi.fn();
      const lines: string[] = [];
      const handler = makeReplElicitationHandler({
        readLine: reader,
        writer: { line: (t = '') => lines.push(t) },
        pendingCount: () => 0,
      });

      const result = await handler(
        formRequest({ name: { type: 'string' } }, ['name', 'missing_required']),
        { signal: NO_SIGNAL },
      );

      expect(result.action).toBe('decline');
      expect(reader).not.toHaveBeenCalled();
      expect(lines.join('\n')).toMatch(/missing_required.*no schema entry/i);
    });

    // H4: integer partial-parse — `'5abc'` and `'5.9'` both pass parseInt
    // but fail the strict-equality post-check; both must re-prompt.
    it('re-prompts integer field on partial-parse inputs and accepts a clean integer', async () => {
      const lines: string[] = [];
      const reader = vi
        .fn()
        .mockResolvedValueOnce('5abc')  // parseInt → 5; String(5) !== '5abc'
        .mockResolvedValueOnce('5.9')   // parseInt → 5; String(5) !== '5.9' (.0+ regex doesn't match)
        .mockResolvedValueOnce('5');    // valid

      const handler = makeReplElicitationHandler({
        readLine: reader,
        writer: { line: (t = '') => lines.push(t) },
        pendingCount: () => 0,
      });

      const result = await handler(
        formRequest({ age: { type: 'integer', description: 'Age' } }, ['age']),
        { signal: NO_SIGNAL },
      );

      expect(result.action).toBe('accept');
      expect(result.content?.['age']).toBe(5);
      expect(result.content?.['age']).not.toBe('5'); // must be number, not string
      const warnings = lines.filter((l) => /invalid integer/i.test(l));
      expect(warnings.length).toBe(2); // one per bad input
      expect(reader).toHaveBeenCalledTimes(3);
    });

    // M7: signal aborted mid-form (between fields) → returns cancel and
    // does not prompt for the remaining fields.
    it('cancels mid-form when signal aborts between fields', async () => {
      const controller = new AbortController();
      const reader = vi
        .fn()
        .mockImplementationOnce(async () => 'value-one') // first field succeeds
        .mockImplementationOnce(async () => {
          // Abort before second readLine returns — promptField checks
          // signal.aborted immediately after each readLine.
          controller.abort();
          return 'value-two';
        });
      const handler = makeReplElicitationHandler({
        readLine: reader,
        writer: { line: vi.fn() },
        pendingCount: () => 0,
      });

      const result = await handler(
        formRequest(
          { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } },
          ['a', 'b', 'c'],
        ),
        { signal: controller.signal },
      );

      expect(result.action).toBe('cancel');
      // Only two reads (first succeeded, second aborted); third never prompted
      expect(reader).toHaveBeenCalledTimes(2);
    });

    // M8: :decline AFTER one or more fields have been collected → returns
    // decline; partial data is discarded (no accept payload leaks).
    it('returns decline when :decline is entered mid-form and discards partial data', async () => {
      const reader = vi
        .fn()
        .mockResolvedValueOnce('first-value')
        .mockResolvedValueOnce(':decline');
      const handler = makeReplElicitationHandler({
        readLine: reader,
        writer: { line: vi.fn() },
        pendingCount: () => 0,
      });

      const result = await handler(
        formRequest({ a: { type: 'string' }, b: { type: 'string' } }, ['a', 'b']),
        { signal: NO_SIGNAL },
      );

      expect(result.action).toBe('decline');
      expect(result.content).toBeUndefined(); // partial collection discarded
      expect(reader).toHaveBeenCalledTimes(2);
    });

    // M9: numeric enum — `type: 'number'` with `enum: [1, 2, 3]` must
    // accept the coerced number; stringwise enum check must succeed.
    it('validates numeric enum and returns the coerced number, not the string', async () => {
      const reader = vi.fn().mockResolvedValueOnce('2');
      const handler = makeReplElicitationHandler({
        readLine: reader,
        writer: { line: vi.fn() },
        pendingCount: () => 0,
      });

      const result = await handler(
        formRequest({ level: { type: 'number', enum: [1, 2, 3] } }, ['level']),
        { signal: NO_SIGNAL },
      );

      expect(result.action).toBe('accept');
      expect(result.content?.['level']).toBe(2);
      expect(typeof result.content?.['level']).toBe('number');
    });

    // M2 regression: escape hatches with leading/trailing whitespace must
    // still trigger the cancel/decline action. Previously the raw-input
    // comparison let ` :cancel` slip through as a literal value.
    it('escape hatches survive paste-mode whitespace (" :cancel", ":decline ")', async () => {
      const reader1 = vi.fn().mockResolvedValueOnce(' :cancel');
      const h1 = makeReplElicitationHandler({
        readLine: reader1,
        writer: { line: vi.fn() },
        pendingCount: () => 0,
      });
      const r1 = await h1(formRequest({ x: { type: 'string' } }, ['x']), {
        signal: NO_SIGNAL,
      });
      expect(r1.action).toBe('cancel');

      const reader2 = vi.fn().mockResolvedValueOnce(':decline ');
      const h2 = makeReplElicitationHandler({
        readLine: reader2,
        writer: { line: vi.fn() },
        pendingCount: () => 0,
      });
      const r2 = await h2(formRequest({ x: { type: 'string' } }, ['x']), {
        signal: NO_SIGNAL,
      });
      expect(r2.action).toBe('decline');
    });

    // M3: declared `default` is surfaced when an optional field is skipped.
    it('applies declared default when an optional field is skipped', async () => {
      const reader = vi.fn().mockResolvedValueOnce(''); // skip
      const handler = makeReplElicitationHandler({
        readLine: reader,
        writer: { line: vi.fn() },
        pendingCount: () => 0,
      });

      const result = await handler(
        formRequest(
          { tier: { type: 'string', default: 'free' } },
          // tier is optional (not in required[])
        ),
        { signal: NO_SIGNAL },
      );

      expect(result.action).toBe('accept');
      expect(result.content?.['tier']).toBe('free');
    });

    // M3: when no default is declared, optional-skip omits the key entirely
    // (preserves prior "user skipped" semantics).
    it('omits an optional field when skipped and no default is declared', async () => {
      const reader = vi.fn().mockResolvedValueOnce(''); // skip
      const handler = makeReplElicitationHandler({
        readLine: reader,
        writer: { line: vi.fn() },
        pendingCount: () => 0,
      });

      const result = await handler(
        formRequest({ tier: { type: 'string' } }), // no default, no required
        { signal: NO_SIGNAL },
      );

      expect(result.action).toBe('accept');
      expect(result.content).toBeDefined();
      expect('tier' in (result.content ?? {})).toBe(false);
    });

    // H3: prototype-pollution — a `__proto__` field on the incoming schema
    // must NOT survive parseProperties and must NOT mutate Object.prototype.
    it('filters __proto__ from schema properties and does not pollute Object.prototype', async () => {
      const reader = vi.fn();
      const handler = makeReplElicitationHandler({
        readLine: reader,
        writer: { line: vi.fn() },
        pendingCount: () => 0,
      });

      // Build a schema with an own enumerable __proto__ key (matching what
      // JSON.parse('{"__proto__": {...}}') produces).
      const propsWithProto: Record<string, unknown> = {};
      Object.defineProperty(propsWithProto, '__proto__', {
        value: { type: 'string', polluted: true },
        enumerable: true,
        configurable: true,
        writable: true,
      });

      const request: ElicitationRequest = {
        serverName: 'evil-mcp',
        message: 'fill out',
        mode: 'form',
        requestedSchema: { type: 'object', properties: propsWithProto },
      };

      const result = await handler(request, { signal: NO_SIGNAL });

      // No fields remained after filtering → decline-on-malformed fires
      expect(result.action).toBe('decline');
      expect(reader).not.toHaveBeenCalled();
      // Object.prototype must remain clean
      const probe = {} as Record<string, unknown>;
      expect(probe['polluted']).toBeUndefined();
      expect((Object.prototype as Record<string, unknown>)['polluted']).toBeUndefined();
    });

    // M1: enum DoS cap — a 10k-value enum must not allocate megabyte hints
    // or hang the validator. We don't measure timing; we just verify the
    // call completes promptly and a valid value (within the cap window) is
    // accepted.
    it('handles enormous enums without hanging (DoS cap on iteration)', async () => {
      const hugeEnum = Array.from({ length: 10000 }, (_, i) => `opt-${i}`);
      const reader = vi.fn().mockResolvedValueOnce('opt-5'); // within MAX_ENUM_VALUES
      const lines: string[] = [];
      const handler = makeReplElicitationHandler({
        readLine: reader,
        writer: { line: (t = '') => lines.push(t) },
        pendingCount: () => 0,
      });

      const result = await handler(
        formRequest({ choice: { type: 'string', enum: hugeEnum } }, ['choice']),
        { signal: NO_SIGNAL },
      );

      expect(result.action).toBe('accept');
      expect(result.content?.['choice']).toBe('opt-5');
      // No single line should be megabyte-class — bound to a few hundred chars
      const maxLine = Math.max(...lines.map((l) => l.length));
      expect(maxLine).toBeLessThan(2000);
    });

    // H1: ANSI sanitisation — schema strings containing CSI escape sequences
    // are stripped before reaching writer.line().
    it('strips ANSI escape sequences from schema description and enum values', async () => {
      // Field is enum-typed, so 'safe' is the valid value to accept.
      const reader = vi.fn().mockResolvedValue('safe');
      const lines: string[] = [];
      const handler = makeReplElicitationHandler({
        readLine: reader,
        writer: { line: (t = '') => lines.push(t) },
        pendingCount: () => 0,
      });

      // ESC[2K (erase line) + ESC[1A (cursor up) — typical overwrite attack
      const evilDesc = 'Innocent\x1b[2K\x1b[1AFORGED';
      const evilEnum = ['safe', 'evil\x1b[31mRED'];

      await handler(
        formRequest(
          { field: { type: 'string', description: evilDesc, enum: evilEnum } },
          ['field'],
        ),
        { signal: NO_SIGNAL },
      );

      const all = lines.join('\n');
      // CSI sequences from MCP-controlled strings must be stripped before
      // reaching writer.line. We test only the schema-derived escapes:
      // `\x1b[2K`, `\x1b[1A`, `\x1b[31m`. The palette helpers' own styling
      // escapes (also CSI but produced by the trusted code path) are not
      // attacker-controlled.
      expect(all).not.toMatch(/\x1b\[2K/);
      expect(all).not.toMatch(/\x1b\[1A/);
      expect(all).not.toMatch(/\x1b\[31m/);
    });
  });
});

// ---------------------------------------------------------------------------
// Agent-question mode tests
// ---------------------------------------------------------------------------

function agentRequest(
  overrides: Partial<ElicitationRequest> = {},
): ElicitationRequest {
  return {
    serverName: 'agent',
    message: 'What is your name?',
    origin: 'agent',
    type: 'text',
    ...overrides,
  };
}

describe('agent-question mode', () => {
  it('text type: returns accept with value on valid input', async () => {
    const handler = makeReplElicitationHandler({
      readLine: vi.fn().mockResolvedValueOnce('Alice'),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
    });
    const result = await handler(agentRequest({ type: 'text' }), { signal: NO_SIGNAL });
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toBe('Alice');
  });

  it('text type: re-prompts on empty input (not allowSkip)', async () => {
    const handler = makeReplElicitationHandler({
      readLine: vi.fn()
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('Bob'),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
    });
    const result = await handler(agentRequest({ type: 'text' }), { signal: NO_SIGNAL });
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toBe('Bob');
  });

  it('text type: allowSkip + empty input gives skip', async () => {
    const handler = makeReplElicitationHandler({
      readLine: vi.fn().mockResolvedValueOnce(''),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
    });
    const result = await handler(agentRequest({ type: 'text', allowSkip: true }), { signal: NO_SIGNAL });
    expect(result.action).toBe('skip');
  });

  it('confirm type: "y" gives accept with value: true', async () => {
    const handler = makeReplElicitationHandler({
      readLine: vi.fn().mockResolvedValueOnce('y'),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
    });
    const result = await handler(agentRequest({ type: 'confirm' }), { signal: NO_SIGNAL });
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toBe(true);
  });

  it('confirm type: "n" gives accept with value: false', async () => {
    const handler = makeReplElicitationHandler({
      readLine: vi.fn().mockResolvedValueOnce('n'),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
    });
    const result = await handler(agentRequest({ type: 'confirm' }), { signal: NO_SIGNAL });
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toBe(false);
  });

  it(':cancel at any prompt gives cancel', async () => {
    const handler = makeReplElicitationHandler({
      readLine: vi.fn().mockResolvedValueOnce(':cancel'),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
    });
    const result = await handler(agentRequest({ type: 'text' }), { signal: NO_SIGNAL });
    expect(result.action).toBe('cancel');
  });

  it('choice type: valid index gives accept with chosen value', async () => {
    const handler = makeReplElicitationHandler({
      readLine: vi.fn().mockResolvedValueOnce('2'),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
    });
    const result = await handler(
      agentRequest({ type: 'choice', choices: ['red', 'blue', 'green'] }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toBe('blue');
  });

  it('choice type: invalid index re-prompts then accepts valid', async () => {
    const lines: string[] = [];
    const handler = makeReplElicitationHandler({
      readLine: vi.fn()
        .mockResolvedValueOnce('5')
        .mockResolvedValueOnce('1'),
      writer: { line: (t = '') => lines.push(t) },
      pendingCount: () => 0,
    });
    const result = await handler(
      agentRequest({ type: 'choice', choices: ['a', 'b', 'c'] }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toBe('a');
    expect(lines.join('\n')).toMatch(/1 and 3/);
  });

  it('multi_choice type: comma-separated indices gives array of values', async () => {
    const handler = makeReplElicitationHandler({
      readLine: vi.fn().mockResolvedValueOnce('1,3'),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
    });
    const result = await handler(
      agentRequest({ type: 'multi_choice', choices: ['choice-a', 'choice-b', 'choice-c'] }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toEqual(['choice-a', 'choice-c']);
  });

  // Issue #502 F8: the multi_choice numbered-list fallback omitted the \x07
  // bell that the choice/confirm fallbacks already emit.
  it('multi_choice type: rings the bell before the numbered fallback list (parity with choice) (#502 F8)', async () => {
    const lines: string[] = [];
    const handler = makeReplElicitationHandler({
      readLine: vi.fn().mockResolvedValueOnce('1,2'),
      writer: { line: (t = '') => lines.push(t) },
      pendingCount: () => 0,
    });
    const result = await handler(
      agentRequest({ type: 'multi_choice', choices: ['a', 'b', 'c'] }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('accept');
    expect(lines).toContain('\x07');
  });

  // Issue #502 F8: the invalid-selection message omitted the custom-answer
  // upper bound that `choice`'s equivalent message already includes.
  it('multi_choice type: invalid-selection message includes the custom-answer slot when allowCustom is set (#502 F8)', async () => {
    const lines: string[] = [];
    const handler = makeReplElicitationHandler({
      readLine: vi.fn()
        .mockResolvedValueOnce('9')   // out of range even counting the custom slot
        .mockResolvedValueOnce('1'),
      writer: { line: (t = '') => lines.push(t) },
      pendingCount: () => 0,
    });
    const result = await handler(
      agentRequest({ type: 'multi_choice', choices: ['a', 'b', 'c'], allowCustom: true }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('accept');
    // 3 real choices + 1 custom slot = upper bound 4 — matches `choice`'s
    // equivalent message (`Please enter a number between 1 and 4.`).
    expect(lines.join('\n')).toMatch(/between 1 and 4\b/);
  });

  // Issue #502 F2: same swallowed-error observability gap in agent-question's
  // readLine catches. One representative site (the default text fallback)
  // confirms the pattern generalizes here too.
  it('logs the underlying readLine error via debugLog under AFK_DEBUG=1 (#502 F2)', async () => {
    const prevDebug = process.env['AFK_DEBUG'];
    process.env['AFK_DEBUG'] = '1';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const reader = vi.fn().mockRejectedValue(new Error('picker dependency crashed'));
      const handler = makeReplElicitationHandler({
        readLine: reader,
        writer: { line: vi.fn() },
        pendingCount: () => 0,
      });
      const result = await handler(agentRequest({ type: 'text' }), { signal: NO_SIGNAL });
      expect(result.action).toBe('cancel');
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('[elicitation]'),
        expect.objectContaining({ message: 'picker dependency crashed' }),
      );
    } finally {
      logSpy.mockRestore();
      if (prevDebug === undefined) delete process.env['AFK_DEBUG'];
      else process.env['AFK_DEBUG'] = prevDebug;
    }
  });

  it('number type: non-numeric re-prompts then accepts valid number', async () => {
    const lines: string[] = [];
    const handler = makeReplElicitationHandler({
      readLine: vi.fn()
        .mockResolvedValueOnce('abc')
        .mockResolvedValueOnce('42'),
      writer: { line: (t = '') => lines.push(t) },
      pendingCount: () => 0,
    });
    const result = await handler(agentRequest({ type: 'number' }), { signal: NO_SIGNAL });
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toBe(42);
    expect(lines.join('\n')).toMatch(/valid number/i);
  });

  it('number type: out-of-bounds re-prompts', async () => {
    const lines: string[] = [];
    const handler = makeReplElicitationHandler({
      readLine: vi.fn()
        .mockResolvedValueOnce('200')
        .mockResolvedValueOnce('50'),
      writer: { line: (t = '') => lines.push(t) },
      pendingCount: () => 0,
    });
    const result = await handler(
      agentRequest({ type: 'number', min: 1, max: 100 }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toBe(50);
    expect(lines.join('\n')).toMatch(/\u2264 100/);
  });

  it('number type: allowSkip + empty gives skip', async () => {
    const handler = makeReplElicitationHandler({
      readLine: vi.fn().mockResolvedValueOnce(''),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
    });
    const result = await handler(
      agentRequest({ type: 'number', allowSkip: true }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('skip');
  });

  // Regression for PR #451 H3: Number('') === 0 passes isFinite, so without the
  // empty-input guard a stray Enter on a required number question silently
  // forwarded `0` to the agent as a deliberate answer.
  it('number type: empty input without allowSkip re-prompts (does not accept 0)', async () => {
    const lines: string[] = [];
    const handler = makeReplElicitationHandler({
      readLine: vi.fn()
        .mockResolvedValueOnce('')      // accidental Enter — must NOT become 0
        .mockResolvedValueOnce('42'),    // valid follow-up
      writer: { line: (t = '') => lines.push(t) },
      pendingCount: () => 0,
    });
    const result = await handler(agentRequest({ type: 'number' }), { signal: NO_SIGNAL });
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toBe(42);
    // Falsifier: if the guard regressed, the handler would resolve on the first
    // empty input with value=0 and never read the '42'.
    expect(result.content?.['value']).not.toBe(0);
  });

  it('queue-depth header appears when pendingCount > 1', async () => {
    const lines: string[] = [];
    const handler = makeReplElicitationHandler({
      readLine: vi.fn().mockResolvedValueOnce('yes'),
      writer: { line: (t = '') => lines.push(t) },
      pendingCount: () => 3,
    });
    await handler(agentRequest({ type: 'confirm' }), { signal: NO_SIGNAL });
    expect(lines.join('\n')).toMatch(/3 questions queued/);
  });

  it('context is displayed above the question', async () => {
    const lines: string[] = [];
    const handler = makeReplElicitationHandler({
      readLine: vi.fn().mockResolvedValueOnce('answer'),
      writer: { line: (t = '') => lines.push(t) },
      pendingCount: () => 0,
    });
    await handler(
      agentRequest({ type: 'text', context: 'Some important background' }),
      { signal: NO_SIGNAL },
    );
    expect(lines.join('\n')).toMatch(/Some important background/);
  });

  it('text type: enforces minLength', async () => {
    const lines: string[] = [];
    const handler = makeReplElicitationHandler({
      readLine: vi.fn()
        .mockResolvedValueOnce('hi')
        .mockResolvedValueOnce('hello'),
      writer: { line: (t = '') => lines.push(t) },
      pendingCount: () => 0,
    });
    const result = await handler(
      agentRequest({ type: 'text', minLength: 4 }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toBe('hello');
    expect(lines.join('\n')).toMatch(/at least 4/i);
  });

  it('text type: enforces maxLength', async () => {
    const lines: string[] = [];
    const handler = makeReplElicitationHandler({
      readLine: vi.fn()
        .mockResolvedValueOnce('toolongtext')
        .mockResolvedValueOnce('ok'),
      writer: { line: (t = '') => lines.push(t) },
      pendingCount: () => 0,
    });
    const result = await handler(
      agentRequest({ type: 'text', maxLength: 5 }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toBe('ok');
    expect(lines.join('\n')).toMatch(/at most 5/i);
  });

  it('aborted signal declines without prompting', async () => {
    const reader = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const handler = makeReplElicitationHandler({
      readLine: reader,
      writer: { line: vi.fn() },
      pendingCount: () => 0,
    });
    const result = await handler(agentRequest(), { signal: controller.signal });
    expect(result.action).toBe('decline');
    expect(reader).not.toHaveBeenCalled();
  });

  // suspendInput / resumeInput hooks
  it('suspendInput is called before readLine and resumeInput after (agent question path)', async () => {
    const suspendCalls: string[] = [];
    const resumeCalls: string[] = [];
    const handler = makeReplElicitationHandler({
      readLine: vi.fn().mockResolvedValueOnce('answer'),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      suspendInput: () => suspendCalls.push('suspend'),
      resumeInput: () => resumeCalls.push('resume'),
    });
    await handler(agentRequest({ type: 'text' }), { signal: NO_SIGNAL });
    expect(suspendCalls.length).toBe(1);
    expect(resumeCalls.length).toBe(1);
  });

  it('resumeInput is called even when readLine rejects (agent question path)', async () => {
    const resumeCalls: string[] = [];
    const handler = makeReplElicitationHandler({
      readLine: vi.fn().mockRejectedValueOnce(new Error('SIGINT')),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      suspendInput: () => {},
      resumeInput: () => resumeCalls.push('resume'),
    });
    const result = await handler(agentRequest({ type: 'text' }), { signal: NO_SIGNAL });
    expect(result.action).toBe('cancel');
    expect(resumeCalls.length).toBe(1);
  });

  it('suspendInput / resumeInput are absent (undefined) — handler runs without error', async () => {
    const handler = makeReplElicitationHandler({
      readLine: vi.fn().mockResolvedValueOnce('hello'),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      // No suspendInput / resumeInput
    });
    const result = await handler(agentRequest({ type: 'text' }), { signal: NO_SIGNAL });
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toBe('hello');
  });

  it('number type: empty input without allowSkip emits a warning (silent-loop fix)', async () => {
    const lines: string[] = [];
    const handler = makeReplElicitationHandler({
      readLine: vi.fn()
        .mockResolvedValueOnce('')   // stray Enter — must warn
        .mockResolvedValueOnce('7'), // valid follow-up
      writer: { line: (t = '') => lines.push(t) },
      pendingCount: () => 0,
    });
    const result = await handler(agentRequest({ type: 'number' }), { signal: NO_SIGNAL });
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toBe(7);
    // The silent-loop bug: previously `continue` fired with no warning.
    // Now a user-visible message must appear.
    expect(lines.join('\n')).toMatch(/enter a number|cancel to skip/i);
  });

  // M3a — choice parseInt guard: '2abc' must be rejected, not silently accepted
  it('choice type: partial-parse input "2abc" re-prompts (M3a fix)', async () => {
    const lines: string[] = [];
    const handler = makeReplElicitationHandler({
      readLine: vi.fn()
        .mockResolvedValueOnce('2abc') // parseInt → 2; String(2) !== '2abc' → reject
        .mockResolvedValueOnce('1'),
      writer: { line: (t = '') => lines.push(t) },
      pendingCount: () => 0,
    });
    const result = await handler(
      agentRequest({ type: 'choice', choices: ['alpha', 'beta'] }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toBe('alpha');
    // Must have emitted a re-prompt warning
    expect(lines.join('\n')).toMatch(/1 and 2/i);
  });

  // M3b — multi_choice parseInt guard: '1abc,2' must be rejected, not split at '1abc'→1
  it('multi_choice type: partial-parse input "1abc,2" re-prompts (M3b fix)', async () => {
    const lines: string[] = [];
    const handler = makeReplElicitationHandler({
      readLine: vi.fn()
        .mockResolvedValueOnce('1abc,2') // '1abc' → parseInt 1; String(1) !== '1abc' → reject
        .mockResolvedValueOnce('1,2'),
      writer: { line: (t = '') => lines.push(t) },
      pendingCount: () => 0,
    });
    const result = await handler(
      agentRequest({ type: 'multi_choice', choices: ['alpha', 'beta', 'gamma'] }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toEqual(['alpha', 'beta']);
    // Must have emitted a re-prompt warning for the invalid part
    expect(lines.join('\n')).toMatch(/invalid selection/i);
  });
});

describe('makeReplElicitationHandler — bell emission', () => {
  // Swap process.stdout.write/isTTY for the duration of `invoke`, capturing
  // every chunk, then restore. Restore from the captured original FUNCTION ref
  // (not by re-reading stdout.write, which would return the replacement).
  async function captureBell(
    opts: { bell: string | undefined; isTTY: boolean },
    invoke: () => Promise<unknown>,
  ): Promise<string[]> {
    const writes: string[] = [];
    const stdout = process.stdout as unknown as { write: unknown; isTTY: unknown };
    const origWrite = stdout.write;
    const origIsTTY = stdout.isTTY;
    stdout.write = (chunk: unknown): boolean => {
      writes.push(String(chunk));
      return true;
    };
    stdout.isTTY = opts.isTTY;
    const origBell = process.env['AFK_BELL'];
    if (opts.bell === undefined) delete process.env['AFK_BELL'];
    else process.env['AFK_BELL'] = opts.bell;
    try {
      await invoke();
    } finally {
      stdout.write = origWrite;
      stdout.isTTY = origIsTTY;
      if (origBell === undefined) delete process.env['AFK_BELL'];
      else process.env['AFK_BELL'] = origBell;
    }
    return writes;
  }

  const mkHandler = () =>
    makeReplElicitationHandler({
      readLine: vi.fn().mockResolvedValue('y'),
      writer: { line: () => {} },
      pendingCount: () => 0,
    });

  it('rings the bell (\\x07) when AFK_BELL=1 and stdout is a TTY', async () => {
    const writes = await captureBell({ bell: '1', isTTY: true }, () =>
      mkHandler()(urlRequest(), { signal: NO_SIGNAL }),
    );
    expect(writes).toContain('\x07');
  });

  it('does not ring when AFK_BELL is unset', async () => {
    const writes = await captureBell({ bell: undefined, isTTY: true }, () =>
      mkHandler()(urlRequest(), { signal: NO_SIGNAL }),
    );
    expect(writes).not.toContain('\x07');
  });

  it('does not ring on a non-TTY stdout even when AFK_BELL=1', async () => {
    const writes = await captureBell({ bell: '1', isTTY: false }, () =>
      mkHandler()(urlRequest(), { signal: NO_SIGNAL }),
    );
    expect(writes).not.toContain('\x07');
  });
});

// ---------------------------------------------------------------------------
// Picker path (pickFromList dependency injected — TTY surfaces)
// ---------------------------------------------------------------------------
//
// The picker dep is injected when an arm()'d compositor is available
// (interactive TTY mode). The handler renders the question prompt +
// options INSIDE the picker frame so they disappear on confirm; only
// the single-line result echo (✓ <value>) survives in scrollback.
// The numbered-text fallback above continues to exercise the non-TTY
// path.
describe('agent-question mode — picker path', () => {
  it('choice + pickFromList: renders header inside picker (NOT via writer.line) and returns selected value', async () => {
    const lines: string[] = [];
    const pickFromList = vi.fn().mockResolvedValueOnce(['blue']);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: (t = '') => lines.push(t) },
      pendingCount: () => 0,
      pickFromList,
    });
    const result = await handler(
      agentRequest({ type: 'choice', message: 'Pick a colour:', choices: ['red', 'blue', 'green'] }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toBe('blue');
    // Picker was called exactly once with the question prompt as a
    // header line (so it renders inside the frame and vanishes on
    // confirm) and the choices as options.
    expect(pickFromList).toHaveBeenCalledTimes(1);
    const call = pickFromList.mock.calls[0]?.[0];
    expect(call?.options).toEqual(['red', 'blue', 'green']);
    expect(call?.multi).toBe(false);
    // Header must contain the question text — that's the whole point
    // (it disappears on confirm).
    const headerJoined = call?.header.join('\n') ?? '';
    expect(headerJoined).toContain('Pick a colour:');
    // Question prompt was NOT written via writer.line (it's in the
    // picker frame, not scrollback).
    expect(lines.some((l) => l.includes('Pick a colour:'))).toBe(false);
    // The numbered "1. red" / "2. blue" lines are also NOT written.
    expect(lines.some((l) => l.match(/^\s*1\. /))).toBe(false);
    // Result echo IS written via writer.line (it persists in scrollback).
    expect(lines.some((l) => l.includes('✓') && l.includes('blue'))).toBe(true);
  });

  it('multi_choice + pickFromList: returns selected values array', async () => {
    const pickFromList = vi.fn().mockResolvedValueOnce(['alpha', 'gamma']);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      pickFromList,
    });
    const result = await handler(
      agentRequest({ type: 'multi_choice', choices: ['alpha', 'beta', 'gamma'] }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toEqual(['alpha', 'gamma']);
    expect(pickFromList.mock.calls[0]?.[0]?.multi).toBe(true);
  });

  it('choice + pickFromList: null result (user cancelled) maps to cancel', async () => {
    const pickFromList = vi.fn().mockResolvedValueOnce(null);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      pickFromList,
    });
    const result = await handler(
      agentRequest({ type: 'choice', choices: ['a', 'b'] }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('cancel');
  });

  it('multi_choice + pickFromList: empty array + allowSkip gives skip', async () => {
    const pickFromList = vi.fn().mockResolvedValueOnce([]);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      pickFromList,
    });
    const result = await handler(
      agentRequest({ type: 'multi_choice', choices: ['a', 'b'], allowSkip: true }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('skip');
  });

  it('multi_choice + pickFromList: empty array + no allowSkip maps to cancel', async () => {
    const pickFromList = vi.fn().mockResolvedValueOnce([]);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      pickFromList,
    });
    const result = await handler(
      agentRequest({ type: 'multi_choice', choices: ['a', 'b'] }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('cancel');
  });

  it('choice + pickFromList: aborted signal returns cancel without invoking picker', async () => {
    const pickFromList = vi.fn().mockResolvedValueOnce(['a']);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      pickFromList,
    });
    const ac = new AbortController();
    ac.abort();
    const result = await handler(
      agentRequest({ type: 'choice', choices: ['a', 'b'] }),
      { signal: ac.signal },
    );
    // Already-aborted signal: handler returns DECLINE before reaching
    // the picker. (See the top-of-handler `if (signal.aborted) return DECLINE`.)
    expect(result.action).toBe('decline');
    expect(pickFromList).not.toHaveBeenCalled();
  });

  it('choice + pickFromList: empty choices array falls back to non-picker path', async () => {
    // The picker path guards `(request.choices?.length ?? 0) > 0` — an
    // empty choices array must not enter the picker (would be useless)
    // and instead falls through to the numbered-text "no choices" path.
    // The legacy numbered-text path will then loop on readLine forever
    // (no valid index) — so we cancel via :cancel.
    const pickFromList = vi.fn();
    const handler = makeReplElicitationHandler({
      readLine: vi.fn().mockResolvedValueOnce(':cancel'),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      pickFromList,
    });
    const result = await handler(
      agentRequest({ type: 'choice', choices: [] }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('cancel');
    expect(pickFromList).not.toHaveBeenCalled();
  });

  it('confirm type with pickFromList routes through Yes/No picker overlay', async () => {
    // Confirm now uses the picker — same vanish-on-confirm UX as choice.
    // Default true → 'Yes' first; user-selected 'Yes' resolves accept:true.
    const pickFromList = vi.fn().mockResolvedValueOnce(['Yes']);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      pickFromList,
    });
    const result = await handler(
      agentRequest({ type: 'confirm' }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toBe(true);
    expect(pickFromList).toHaveBeenCalledTimes(1);
    expect(pickFromList.mock.calls[0]?.[0]?.options).toEqual(['Yes', 'No']);
    expect(pickFromList.mock.calls[0]?.[0]?.multi).toBe(false);
  });

  it('confirm type with default false starts with No highlighted first', async () => {
    const pickFromList = vi.fn().mockResolvedValueOnce(['No']);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      pickFromList,
    });
    const result = await handler(
      agentRequest({ type: 'confirm', questionDefault: false }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toBe(false);
    // Options reorder when default is false → [No, Yes]
    expect(pickFromList.mock.calls[0]?.[0]?.options).toEqual(['No', 'Yes']);
  });

  it('confirm type without pickFromList falls back to readLine', async () => {
    const handler = makeReplElicitationHandler({
      readLine: vi.fn().mockResolvedValueOnce('y'),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
    });
    const result = await handler(
      agentRequest({ type: 'confirm' }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toBe(true);
  });

  it('text type with pickFromList only (no readTextOverlay) uses readLine', async () => {
    // pickFromList is wired for choice; text without readTextOverlay
    // falls through to the legacy numbered readLine path.
    const pickFromList = vi.fn();
    const handler = makeReplElicitationHandler({
      readLine: vi.fn().mockResolvedValueOnce('hello'),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      pickFromList,
    });
    const result = await handler(
      agentRequest({ type: 'text' }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toBe('hello');
    expect(pickFromList).not.toHaveBeenCalled();
  });

  it('text type with readTextOverlay routes through the overlay', async () => {
    const readTextOverlay = vi.fn().mockResolvedValueOnce('answer text');
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      readTextOverlay,
    });
    const result = await handler(
      agentRequest({ type: 'text' }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toBe('answer text');
    expect(readTextOverlay).toHaveBeenCalledTimes(1);
  });

  it('text type with readTextOverlay null result maps to cancel', async () => {
    const readTextOverlay = vi.fn().mockResolvedValueOnce(null);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      readTextOverlay,
    });
    const result = await handler(
      agentRequest({ type: 'text' }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('cancel');
  });

  it('text type with readTextOverlay empty buffer + allowSkip maps to skip', async () => {
    const readTextOverlay = vi.fn().mockResolvedValueOnce('');
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      readTextOverlay,
    });
    const result = await handler(
      agentRequest({ type: 'text', allowSkip: true }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('skip');
  });

  it('number type with readTextOverlay parses the typed value', async () => {
    const readTextOverlay = vi.fn().mockResolvedValueOnce('42');
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      readTextOverlay,
    });
    const result = await handler(
      agentRequest({ type: 'number' }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toBe(42);
  });

  it('number type with readTextOverlay null result maps to cancel', async () => {
    const readTextOverlay = vi.fn().mockResolvedValueOnce(null);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      readTextOverlay,
    });
    const result = await handler(
      agentRequest({ type: 'number' }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('cancel');
  });

  it('number type validate rejects non-numeric and out-of-range', async () => {
    let lastValidate: ((v: string) => string | null) | undefined;
    const readTextOverlay = vi.fn().mockImplementation((opts: { validate?: (v: string) => string | null }) => {
      lastValidate = opts.validate;
      return Promise.resolve('5');
    });
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      readTextOverlay,
    });
    await handler(
      agentRequest({ type: 'number', min: 1, max: 10 }),
      { signal: NO_SIGNAL },
    );
    expect(lastValidate).toBeDefined();
    expect(lastValidate!('abc')).toContain('valid number');
    expect(lastValidate!('0')).toContain('\u2265 1');
    expect(lastValidate!('99')).toContain('\u2264 10');
    expect(lastValidate!('5')).toBeNull();
  });

  it('choice + pickFromList rejecting maps to cancel', async () => {
    const pickFromList = vi.fn().mockRejectedValueOnce(new Error('picker crash'));
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      pickFromList,
    });
    const result = await handler(
      agentRequest({ type: 'choice', choices: ['a', 'b'] }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('cancel');
  });

  it('result echo line uses brand colour and contains selected value', async () => {
    const lines: string[] = [];
    const pickFromList = vi.fn().mockResolvedValueOnce(['gamma']);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: (t = '') => lines.push(t) },
      pendingCount: () => 0,
      pickFromList,
    });
    await handler(
      agentRequest({ type: 'choice', choices: ['alpha', 'beta', 'gamma'] }),
      { signal: NO_SIGNAL },
    );
    // Strip ANSI to verify the echo content + glyph regardless of palette.
    const stripped = lines.map((l) => l.replace(/\u001b\[[0-9;]*m/g, ''));
    expect(stripped.some((s) => s.includes('✓') && s.includes('gamma'))).toBe(true);
  });

  it('multi_choice echo joins selections with comma-space', async () => {
    const lines: string[] = [];
    const pickFromList = vi.fn().mockResolvedValueOnce(['alpha', 'gamma']);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: (t = '') => lines.push(t) },
      pendingCount: () => 0,
      pickFromList,
    });
    await handler(
      agentRequest({ type: 'multi_choice', choices: ['alpha', 'beta', 'gamma'] }),
      { signal: NO_SIGNAL },
    );
    const stripped = lines.map((l) => l.replace(/\u001b\[[0-9;]*m/g, ''));
    expect(stripped.some((s) => s.includes('alpha, gamma'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// allow_custom — overlay path (choice/multi_choice via pickFromList)
// ---------------------------------------------------------------------------

import { CUSTOM_ANSWER_SENTINEL, renderMultiSelector, renderSelector } from './input/selectors.js';

describe('allow_custom — overlay path (choice)', () => {
  it('sentinel selected → readTextOverlay called → returns { value: null, custom_value }', async () => {
    const lines: string[] = [];
    const readTextOverlay = vi.fn().mockResolvedValueOnce('typed text');
    const pickFromList = vi.fn().mockResolvedValueOnce([CUSTOM_ANSWER_SENTINEL]);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: (t = '') => lines.push(t) },
      pendingCount: () => 0,
      pickFromList,
      readTextOverlay,
    });
    const result = await handler(
      agentRequest({ type: 'choice', choices: ['alpha', 'beta'], allowCustom: true }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toBeNull();
    expect(result.content?.['custom_value']).toBe('typed text');
    expect(readTextOverlay).toHaveBeenCalledTimes(1);
    // Result echo written via writer.line
    expect(lines.some((l) => l.includes('typed text'))).toBe(true);
  });

  it('sentinel selected + readTextOverlay returns null (Esc) → cancel', async () => {
    const readTextOverlay = vi.fn().mockResolvedValueOnce(null);
    const pickFromList = vi.fn().mockResolvedValueOnce([CUSTOM_ANSWER_SENTINEL]);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      pickFromList,
      readTextOverlay,
    });
    const result = await handler(
      agentRequest({ type: 'choice', choices: ['alpha', 'beta'], allowCustom: true }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('cancel');
  });

  it('without allowCustom, sentinel is NOT appended to the options', async () => {
    const pickFromList = vi.fn().mockResolvedValueOnce(['alpha']);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      pickFromList,
    });
    await handler(
      agentRequest({ type: 'choice', choices: ['alpha', 'beta'] }),
      { signal: NO_SIGNAL },
    );
    const call = pickFromList.mock.calls[0]?.[0];
    expect(call?.options).toEqual(['alpha', 'beta']);
    expect(call?.options).not.toContain(CUSTOM_ANSWER_SENTINEL);
  });

  it('with allowCustom, sentinel IS appended to the options passed to pickFromList', async () => {
    const pickFromList = vi.fn().mockResolvedValueOnce(['alpha']);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      pickFromList,
    });
    await handler(
      agentRequest({ type: 'choice', choices: ['alpha', 'beta'], allowCustom: true }),
      { signal: NO_SIGNAL },
    );
    const call = pickFromList.mock.calls[0]?.[0];
    expect(call?.options).toContain(CUSTOM_ANSWER_SENTINEL);
    expect(call?.options[2]).toBe(CUSTOM_ANSWER_SENTINEL);
  });

  it('sentinel selected but readTextOverlay absent → cancel (graceful degrade)', async () => {
    const pickFromList = vi.fn().mockResolvedValueOnce([CUSTOM_ANSWER_SENTINEL]);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      pickFromList,
      // readTextOverlay not provided
    });
    const result = await handler(
      agentRequest({ type: 'choice', choices: ['alpha', 'beta'], allowCustom: true }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('cancel');
  });
});

describe('allow_custom — overlay path (multi_choice)', () => {
  it('sentinel selected → readTextOverlay called → returns { value: null, custom_value }', async () => {
    const readTextOverlay = vi.fn().mockResolvedValueOnce('free text answer');
    const pickFromList = vi.fn().mockResolvedValueOnce([CUSTOM_ANSWER_SENTINEL]);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      pickFromList,
      readTextOverlay,
    });
    const result = await handler(
      agentRequest({ type: 'multi_choice', choices: ['alpha', 'beta'], allowCustom: true }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toBeNull();
    expect(result.content?.['custom_value']).toBe('free text answer');
  });

  it('sentinel selected + readTextOverlay returns null → cancel', async () => {
    const readTextOverlay = vi.fn().mockResolvedValueOnce(null);
    const pickFromList = vi.fn().mockResolvedValueOnce([CUSTOM_ANSWER_SENTINEL]);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      pickFromList,
      readTextOverlay,
    });
    const result = await handler(
      agentRequest({ type: 'multi_choice', choices: ['alpha', 'beta'], allowCustom: true }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('cancel');
  });

  it('without allowCustom, sentinel not appended', async () => {
    const pickFromList = vi.fn().mockResolvedValueOnce(['alpha']);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      pickFromList,
    });
    await handler(
      agentRequest({ type: 'multi_choice', choices: ['alpha', 'beta'] }),
      { signal: NO_SIGNAL },
    );
    const call = pickFromList.mock.calls[0]?.[0];
    expect(call?.options).not.toContain(CUSTOM_ANSWER_SENTINEL);
  });

  it('mixed selection (real option + sentinel) routes to custom entry — sentinel never leaks into value', async () => {
    // Regression: the sentinel guard previously required exactly one selection,
    // so picking a real option together with the sentinel leaked the sentinel
    // label into value[]. Presence of the sentinel must route to free-form entry.
    const readTextOverlay = vi.fn().mockResolvedValueOnce('typed override');
    const pickFromList = vi.fn().mockResolvedValueOnce(['alpha', CUSTOM_ANSWER_SENTINEL]);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      pickFromList,
      readTextOverlay,
    });
    const result = await handler(
      agentRequest({ type: 'multi_choice', choices: ['alpha', 'beta'], allowCustom: true }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toBeNull();
    expect(result.content?.['custom_value']).toBe('typed override');
    expect(readTextOverlay).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// allow_custom — non-TTY numbered-list fallback (choice)
// ---------------------------------------------------------------------------

describe('allow_custom — non-TTY numbered-list fallback (choice)', () => {
  it('entering N+1 triggers readLine custom text prompt → returns { value: null, custom_value }', async () => {
    const lines: string[] = [];
    const handler = makeReplElicitationHandler({
      readLine: vi.fn()
        .mockResolvedValueOnce('3')        // select sentinel (index 3 = choice 3 of 2 + 1)
        .mockResolvedValueOnce('my custom answer'),
      writer: { line: (t = '') => lines.push(t) },
      pendingCount: () => 0,
      // no pickFromList → falls through to numbered list
    });
    const result = await handler(
      agentRequest({ type: 'choice', choices: ['alpha', 'beta'], allowCustom: true }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toBeNull();
    expect(result.content?.['custom_value']).toBe('my custom answer');
    // Sentinel item rendered in numbered list
    expect(lines.some((l) => l.includes(CUSTOM_ANSWER_SENTINEL))).toBe(true);
  });

  it('entering :cancel from custom text prompt → cancel', async () => {
    const handler = makeReplElicitationHandler({
      readLine: vi.fn()
        .mockResolvedValueOnce('3')
        .mockResolvedValueOnce(':cancel'),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
    });
    const result = await handler(
      agentRequest({ type: 'choice', choices: ['alpha', 'beta'], allowCustom: true }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('cancel');
  });

  it('without allowCustom, no N+1 item listed', async () => {
    const lines: string[] = [];
    const handler = makeReplElicitationHandler({
      readLine: vi.fn().mockResolvedValueOnce(':cancel'),
      writer: { line: (t = '') => lines.push(t) },
      pendingCount: () => 0,
    });
    await handler(
      agentRequest({ type: 'choice', choices: ['alpha', 'beta'] }),
      { signal: NO_SIGNAL },
    );
    expect(lines.some((l) => l.includes(CUSTOM_ANSWER_SENTINEL))).toBe(false);
  });

  it('normal choice selection still works when allowCustom is true', async () => {
    const handler = makeReplElicitationHandler({
      readLine: vi.fn().mockResolvedValueOnce('1'),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
    });
    const result = await handler(
      agentRequest({ type: 'choice', choices: ['alpha', 'beta'], allowCustom: true }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toBe('alpha');
  });
});

// ---------------------------------------------------------------------------
// allow_custom — non-TTY numbered-list fallback (multi_choice)
// ---------------------------------------------------------------------------

describe('allow_custom — non-TTY numbered-list fallback (multi_choice)', () => {
  it('entering N+1 triggers readLine custom text prompt → returns { value: null, custom_value }', async () => {
    const lines: string[] = [];
    const handler = makeReplElicitationHandler({
      readLine: vi.fn()
        .mockResolvedValueOnce('3')        // sentinel = index 3 for 2 choices
        .mockResolvedValueOnce('custom multi answer'),
      writer: { line: (t = '') => lines.push(t) },
      pendingCount: () => 0,
    });
    const result = await handler(
      agentRequest({ type: 'multi_choice', choices: ['alpha', 'beta'], allowCustom: true }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toBeNull();
    expect(result.content?.['custom_value']).toBe('custom multi answer');
    expect(lines.some((l) => l.includes(CUSTOM_ANSWER_SENTINEL))).toBe(true);
  });

  it('entering :cancel from custom text prompt (multi) → cancel', async () => {
    const handler = makeReplElicitationHandler({
      readLine: vi.fn()
        .mockResolvedValueOnce('3')
        .mockResolvedValueOnce(':cancel'),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
    });
    const result = await handler(
      agentRequest({ type: 'multi_choice', choices: ['alpha', 'beta'], allowCustom: true }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('cancel');
  });

  it('without allowCustom, sentinel not rendered', async () => {
    const lines: string[] = [];
    const handler = makeReplElicitationHandler({
      readLine: vi.fn().mockResolvedValueOnce(':cancel'),
      writer: { line: (t = '') => lines.push(t) },
      pendingCount: () => 0,
    });
    await handler(
      agentRequest({ type: 'multi_choice', choices: ['alpha', 'beta'] }),
      { signal: NO_SIGNAL },
    );
    expect(lines.some((l) => l.includes(CUSTOM_ANSWER_SENTINEL))).toBe(false);
  });

  it('normal multi_choice selection still works when allowCustom is true', async () => {
    const handler = makeReplElicitationHandler({
      readLine: vi.fn().mockResolvedValueOnce('1,2'),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
    });
    const result = await handler(
      agentRequest({ type: 'multi_choice', choices: ['alpha', 'beta'], allowCustom: true }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toEqual(['alpha', 'beta']);
  });
});

// ---------------------------------------------------------------------------
// allow_custom — TTY arrow-key multi-selector path (renderMultiSelector)
//
// The TTY selector returns null in the non-TTY test env, so the existing tests
// only reach the overlay (pickFromList) and numbered-list paths. We mock the
// selector module to return indices and exercise the real TTY branch — including
// the mixed real-option + sentinel selection that previously indexed choices[]
// out of range (undefined → thrown TypeError in sanitizeSchemaString).
//
// The mock defaults to the REAL implementation (null in non-TTY), so every
// other test in this file is unaffected.
// ---------------------------------------------------------------------------

vi.mock('./input/selectors.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./input/selectors.js')>();
  return {
    ...actual,
    renderSelector: vi.fn(actual.renderSelector),
    renderMultiSelector: vi.fn(actual.renderMultiSelector),
  };
});

describe('allow_custom — TTY multi-selector path (renderMultiSelector)', () => {
  it('real option + sentinel together routes to custom entry (no undefined / no throw)', async () => {
    // selectorResult = [0, 2]: index 0 = "alpha", index 2 = sentinel (choices.length).
    vi.mocked(renderMultiSelector).mockResolvedValueOnce([0, 2]);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn().mockResolvedValueOnce('tty custom answer'),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      // no pickFromList → falls through to the renderMultiSelector TTY path
    });
    const result = await handler(
      agentRequest({ type: 'multi_choice', choices: ['alpha', 'beta'], allowCustom: true }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toBeNull();
    expect(result.content?.['custom_value']).toBe('tty custom answer');
  });

  it('real options only still returns selected values when allowCustom is on', async () => {
    vi.mocked(renderMultiSelector).mockResolvedValueOnce([0, 1]);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
    });
    const result = await handler(
      agentRequest({ type: 'multi_choice', choices: ['alpha', 'beta'], allowCustom: true }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('accept');
    expect(result.content?.['value']).toEqual(['alpha', 'beta']);
  });
});

// Issue #502 F3: renderSelector should only ever return an index inside
// choices[], but a genuine selector/choices-array desync previously returned
// CANCEL with no diagnostic — indistinguishable from a normal user cancel.
// Reuses the module-mock scaffold declared above (defaults to the real,
// non-TTY-null implementation for every other test in this file).
describe('TTY single-selector path (renderSelector) — out-of-range index', () => {
  it('choice TTY selector returning an out-of-range index cancels (not a throw) (#502 F3)', async () => {
    vi.mocked(renderSelector).mockResolvedValueOnce(99);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
    });
    const result = await handler(
      agentRequest({ type: 'choice', choices: ['a', 'b'] }),
      { signal: NO_SIGNAL },
    );
    expect(result.action).toBe('cancel');
  });
});

// ---------------------------------------------------------------------------
// Form mode — picker path (enum / boolean fields + pickFromList, TTY surfaces)
// ---------------------------------------------------------------------------
//
// When a pickFromList dep is wired (armed compositor / interactive TTY), an
// `enum` or `boolean` form field is rendered as the arrow-key PickerController
// overlay — the same component the ask_question choice prompts use — instead
// of a typed `> ` readLine prompt. This is what makes the path-approval prompt
// (a single enum field) a keyboard selector. Without the dep (non-TTY/daemon/
// tests), the typed path remains the fallback.
describe('form mode — picker path (enum/boolean)', () => {
  // Mirrors the path-approval hook's form: one required enum field.
  function pathApprovalForm(): ElicitationRequest {
    return formRequest(
      {
        choice: {
          type: 'string',
          title: 'Choose one',
          enum: ['once', 'session', 'persist', 'deny'],
          description: "'once' allows this single call only. 'session' allows this path until the session ends.",
        },
      },
      ['choice'],
    );
  }

  it('enum field + pickFromList: renders a selector and returns the picked value (no typed prompt)', async () => {
    const lines: string[] = [];
    const readLine = vi.fn();
    const pickFromList = vi.fn().mockResolvedValueOnce(['session']);
    const handler = makeReplElicitationHandler({
      readLine,
      writer: { line: (t = '') => lines.push(t) },
      pendingCount: () => 0,
      pickFromList,
    });

    const result = await handler(pathApprovalForm(), { signal: NO_SIGNAL });

    expect(result.action).toBe('accept');
    expect(result.content?.['choice']).toBe('session');
    // Selector was used, NOT the typed readLine prompt.
    expect(pickFromList).toHaveBeenCalledTimes(1);
    expect(readLine).not.toHaveBeenCalled();
    const call = pickFromList.mock.calls[0]?.[0];
    expect(call?.options).toEqual(['once', 'session', 'persist', 'deny']);
    expect(call?.multi).toBe(false);
    // Result echo persists in scrollback.
    expect(lines.some((l) => l.includes('\u2713') && l.includes('session'))).toBe(true);
  });

  it('enum field WITHOUT pickFromList: falls back to the typed readLine path', async () => {
    const readLine = vi.fn().mockResolvedValueOnce('persist');
    const handler = makeReplElicitationHandler({
      readLine,
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      // no pickFromList → typed fallback
    });

    const result = await handler(pathApprovalForm(), { signal: NO_SIGNAL });

    expect(result.action).toBe('accept');
    expect(result.content?.['choice']).toBe('persist');
    expect(readLine).toHaveBeenCalledTimes(1);
  });

  it('enum field + pickFromList: null result (Esc/Ctrl+C) maps to cancel', async () => {
    const pickFromList = vi.fn().mockResolvedValueOnce(null);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      pickFromList,
    });

    const result = await handler(pathApprovalForm(), { signal: NO_SIGNAL });
    expect(result.action).toBe('cancel');
  });

  it('number-typed enum + pickFromList: preserves the original numeric type', async () => {
    const pickFromList = vi.fn().mockResolvedValueOnce(['2']);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      pickFromList,
    });

    const result = await handler(
      formRequest({ n: { type: 'number', enum: [1, 2, 3] } }, ['n']),
      { signal: NO_SIGNAL },
    );

    expect(result.action).toBe('accept');
    // Selector returns the display string '2'; resolver maps it back to the
    // original numeric enum entry.
    expect(result.content?.['n']).toBe(2);
  });

  it('boolean field + pickFromList: Yes/No selector maps to true/false', async () => {
    const pickFromList = vi.fn().mockResolvedValueOnce(['No']);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      pickFromList,
    });

    const result = await handler(
      formRequest({ enabled: { type: 'boolean', description: 'Enabled?' } }, ['enabled']),
      { signal: NO_SIGNAL },
    );

    expect(result.action).toBe('accept');
    expect(result.content?.['enabled']).toBe(false);
    expect(pickFromList.mock.calls[0]?.[0]?.options).toEqual(['Yes', 'No']);
  });

  it('optional enum field + pickFromList: choosing the skip sentinel omits the field', async () => {
    // The skip sentinel is the last option for an OPTIONAL field.
    const pickFromList = vi.fn().mockImplementationOnce(async (opts: { options: readonly string[] }) => {
      const sentinel = opts.options[opts.options.length - 1];
      return [sentinel];
    });
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      pickFromList,
    });

    // `mode` optional (not in required[]).
    const result = await handler(
      formRequest({ mode: { type: 'string', enum: ['fast', 'slow'] } }),
      { signal: NO_SIGNAL },
    );

    expect(result.action).toBe('accept');
    // Skipped optional field is omitted from content (no default declared).
    expect(result.content && 'mode' in result.content).toBe(false);
    // Sentinel was appended after the real options.
    expect(pickFromList.mock.calls[0]?.[0]?.options.length).toBe(3);
  });

  // Issue #502 F4: two distinct enum values can stringify/sanitize to the
  // same display label (numeric 1 vs string "1"). Before the fix,
  // `indexOf` always resolved to the FIRST matching label, so picking the
  // second "1" silently returned the value at the first "1"'s index instead.
  it('enum field with colliding labels: resolves to the ORIGINAL value at the picked index, not the first match (#502 F4)', async () => {
    const lines: string[] = [];
    // enumValues = [1, "1", 2] → labels before disambiguation = ["1", "1", "2"].
    const pickFromList = vi.fn().mockImplementationOnce(async (opts: { options: readonly string[] }) => {
      // Options are disambiguated: ["1 (1)", "1 (2)", "2"]. Pick the SECOND
      // "1" — the one that maps back to the string enum entry, not the
      // numeric one at index 0.
      expect(opts.options).toEqual(['1 (1)', '1 (2)', '2']);
      return [opts.options[1]];
    });
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: (t = '') => lines.push(t) },
      pendingCount: () => 0,
      pickFromList,
    });

    const result = await handler(
      formRequest({ field: { type: 'string', enum: [1, '1', 2] } }, ['field']),
      { signal: NO_SIGNAL },
    );

    expect(result.action).toBe('accept');
    // Must be the STRING "1" (index 1), not the number 1 (index 0) that an
    // indexOf-on-colliding-labels bug would have silently substituted.
    expect(result.content?.['field']).toBe('1');
    expect(typeof result.content?.['field']).toBe('string');
    // The disambiguated label is what actually got echoed — documents the
    // (unavoidable) echo-format change the fix introduces for this rare case.
    expect(lines.some((l) => l.includes('1 (2)'))).toBe(true);
  });

  // Issue #502 F4 hardening: a raw enum value can itself look like a
  // disambiguated suffix. A naive single-pass scheme (count original
  // duplicates, suffix each occurrence from that count alone) suffixes the
  // second 'dup' to 'dup (2)', which then collides with the third, distinct
  // raw entry that already reads 'dup (2)' — reintroducing the exact
  // ambiguity the fix exists to remove, one level deeper. Every option must
  // stay globally unique and round-trip to its own original enum index.
  it('enum field with a nested label collision (a raw value that already looks like a disambiguated suffix): every option stays unique (#502 F4 hardening)', async () => {
    const pickFromList = vi.fn().mockImplementationOnce(async (opts: { options: readonly string[] }) => {
      expect(new Set(opts.options).size).toBe(opts.options.length);
      // Pick the LAST rendered option — it must resolve back to the LAST
      // enum entry (the literal string 'dup (2)'), never to the second
      // 'dup' that a naive suffix scheme would alias it with.
      return [opts.options[opts.options.length - 1]];
    });
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      pickFromList,
    });

    const result = await handler(
      formRequest({ field: { type: 'string', enum: ['dup', 'dup', 'dup (2)'] } }, ['field']),
      { signal: NO_SIGNAL },
    );

    expect(result.action).toBe('accept');
    expect(result.content?.['field']).toBe('dup (2)');
  });

  // Issue #502 F4: non-colliding enums (the overwhelming common case) must
  // render EXACTLY as before — disambiguation should be invisible unless a
  // collision actually exists.
  it('enum field WITHOUT colliding labels: renders unmodified options (#502 F4 regression guard)', async () => {
    const pickFromList = vi.fn().mockImplementationOnce(async (opts: { options: readonly string[] }) => {
      expect(opts.options).toEqual(['once', 'session', 'persist', 'deny']);
      return ['persist'];
    });
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      pickFromList,
    });

    const result = await handler(pathApprovalForm(), { signal: NO_SIGNAL });
    expect(result.action).toBe('accept');
    expect(result.content?.['choice']).toBe('persist');
  });

  // Issue #502 F4: an enum value that literally equals the FORM_SKIP_SENTINEL
  // string made the real enum value unselectable — both it and the actual
  // skip option rendered identically, and the code always treated a pick of
  // that label as skip. After the fix the colliding enum entry gets a
  // disambiguating suffix, so it is selectable and distinct from real skip.
  it('optional enum field with a value equal to the skip sentinel: stays selectable and distinct from real skip (#502 F4)', async () => {
    const SKIP_SENTINEL_TEXT = '\u2014 skip (optional) \u2014';
    const pickFromList = vi.fn().mockImplementationOnce(async (opts: { options: readonly string[] }) => {
      // 2 enum values + 1 real trailing skip sentinel.
      expect(opts.options.length).toBe(3);
      // The colliding enum entry must be disambiguated (not textually equal
      // to the plain sentinel) so it never gets misread as the skip action...
      expect(opts.options[0]).not.toBe(SKIP_SENTINEL_TEXT);
      // ...while the TRUE trailing skip option keeps its exact, unmodified
      // meaning.
      expect(opts.options[2]).toBe(SKIP_SENTINEL_TEXT);
      // Pick the disambiguated enum entry — NOT the real skip option.
      return [opts.options[0]];
    });
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      pickFromList,
    });

    // `weird` optional (not in required[]) so the skip sentinel is appended.
    const result = await handler(
      formRequest({ weird: { type: 'string', enum: [SKIP_SENTINEL_TEXT, 'other'] } }),
      { signal: NO_SIGNAL },
    );

    expect(result.action).toBe('accept');
    // The real enum value was returned — NOT the skip/default outcome a
    // label collision would previously have forced.
    expect(result.content?.['weird']).toBe(SKIP_SENTINEL_TEXT);
  });

  // Issue #502 F4: the real skip action must still work when a colliding
  // enum value has been pushed aside by disambiguation.
  it('optional enum field with a value equal to the skip sentinel: the real skip option still skips (#502 F4)', async () => {
    const SKIP_SENTINEL_TEXT = '\u2014 skip (optional) \u2014';
    const pickFromList = vi.fn().mockImplementationOnce(async (opts: { options: readonly string[] }) => {
      // Pick the LAST option — the real, unmodified skip sentinel.
      return [opts.options[opts.options.length - 1]];
    });
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: vi.fn() },
      pendingCount: () => 0,
      pickFromList,
    });

    const result = await handler(
      formRequest({ weird: { type: 'string', enum: [SKIP_SENTINEL_TEXT, 'other'] } }),
      { signal: NO_SIGNAL },
    );

    expect(result.action).toBe('accept');
    // Skipped optional field with no declared default is omitted entirely.
    expect(result.content && 'weird' in result.content).toBe(false);
  });
});
