import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

const routedOneShotWithStop = vi.fn();
vi.mock('../../providers/shared/one-shot-router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../providers/shared/one-shot-router.js')>();
  return {
    ...actual,
    routedOneShotWithStop: (...args: unknown[]) => routedOneShotWithStop(...args),
  };
});

import {
  createModelCompleteHandler,
  defaultModelCompleteModel,
  MAX_INPUT_BYTES,
  MAX_REPLY_CHARS,
  parseModelCompleteInput,
} from './model-complete.js';
import {
  CLAUDE_HAIKU_ID,
  DEFAULT_SLOT_BINDINGS,
  resetSlotBindings,
  setSlotBindings,
  type ModelSlots,
} from '../../session/model-slots.js';

const LOCAL_SLOTS: ModelSlots = {
  ...DEFAULT_SLOT_BINDINGS,
  local: {
    id: 'qwen-test-27b',
    name: 'cerebras',
    provider: 'openai',
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'slot-key',
  },
};

let tmp: string;
const signal = () => new AbortController().signal;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'afk-model-complete-'));
  routedOneShotWithStop.mockReset();
  routedOneShotWithStop.mockResolvedValue({ text: 'the reply', stopReason: 'end' });
  setSlotBindings(LOCAL_SLOTS);
  // The handler defaults `model` to AFK_MODEL; pin it so routing tests are
  // independent of the developer's environment.
  vi.stubEnv('AFK_MODEL', 'local');
  vi.stubEnv('CLAUDE_MODEL', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetSlotBindings();
  rmSync(tmp, { recursive: true, force: true });
});

describe('parseModelCompleteInput', () => {
  it('rejects a missing or blank prompt', () => {
    expect(parseModelCompleteInput({})).toMatchObject({ isError: true });
    expect(parseModelCompleteInput({ prompt: '   ' })).toMatchObject({ isError: true });
  });

  it('defaults model to AFK_MODEL and max_tokens to 4096', () => {
    expect(parseModelCompleteInput({ prompt: 'hi' })).toEqual({
      prompt: 'hi',
      model: 'local',
      maxTokens: 4096,
    });
  });

  it('clamps max_tokens into 1..32000', () => {
    expect(parseModelCompleteInput({ prompt: 'x', max_tokens: 999_999 })).toMatchObject({ maxTokens: 32_000 });
    expect(parseModelCompleteInput({ prompt: 'x', max_tokens: -5 })).toMatchObject({ maxTokens: 1 });
  });

  it('rejects the auto routing sentinel', () => {
    expect(parseModelCompleteInput({ prompt: 'x', model: 'auto' })).toMatchObject({ isError: true });
  });
});

describe('defaultModelCompleteModel', () => {
  it('uses AFK_MODEL, trimmed', () => {
    vi.stubEnv('AFK_MODEL', '  opus ');
    expect(defaultModelCompleteModel()).toBe('opus');
  });

  it('falls back to legacy CLAUDE_MODEL, then the medium tier', () => {
    vi.stubEnv('AFK_MODEL', undefined);
    vi.stubEnv('CLAUDE_MODEL', 'haiku');
    expect(defaultModelCompleteModel()).toBe('haiku');
    vi.stubEnv('CLAUDE_MODEL', undefined);
    expect(defaultModelCompleteModel()).toBe('medium');
  });

  it('maps the auto routing sentinel and a blank value to medium', () => {
    vi.stubEnv('AFK_MODEL', 'auto');
    expect(defaultModelCompleteModel()).toBe('medium');
    vi.stubEnv('AFK_MODEL', '   ');
    expect(defaultModelCompleteModel()).toBe('medium');
  });

  it('routes an omitted model to the AFK_MODEL target', async () => {
    vi.stubEnv('AFK_MODEL', 'haiku');
    await createModelCompleteHandler(tmp)({ prompt: 'x' }, signal());
    expect(routedOneShotWithStop.mock.calls[0]?.[0]).toMatchObject({
      model: CLAUDE_HAIKU_ID,
      provider: 'anthropic-direct',
    });
  });
});

describe('model_complete handler', () => {
  it('routes the local slot (via AFK_MODEL) with its provider, endpoint, and key', async () => {
    const res = await createModelCompleteHandler(tmp)({ prompt: 'summarize' }, signal());
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain('the reply');
    expect(res.content).toContain('[model_complete: qwen-test-27b via openai-compatible]');
    const call = routedOneShotWithStop.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      model: 'qwen-test-27b',
      provider: 'openai-compatible',
      binding: { apiKey: 'slot-key', baseUrl: 'https://api.example.test/v1', provider: 'openai' },
      user: 'summarize',
      maxTokens: 4096,
    });
    expect(call.system).toMatch(/answer the request directly/i);
  });

  it('resolves a custom slot name and an identity alias', async () => {
    const handler = createModelCompleteHandler(tmp);
    await handler({ prompt: 'a', model: 'cerebras' }, signal());
    expect(routedOneShotWithStop.mock.calls[0]?.[0]).toMatchObject({ model: 'qwen-test-27b' });
    await handler({ prompt: 'b', model: 'haiku', system: 'be terse' }, signal());
    expect(routedOneShotWithStop.mock.calls[1]?.[0]).toMatchObject({
      model: CLAUDE_HAIKU_ID,
      provider: 'anthropic-direct',
      system: 'be terse',
    });
  });

  it('rejects an unconfigured slot without calling any provider', async () => {
    setSlotBindings({ ...DEFAULT_SLOT_BINDINGS });
    const res = await createModelCompleteHandler(tmp)({ prompt: 'x' }, signal());
    expect(res.isError).toBe(true);
    expect(res.content).toContain('AFK_MODEL_LOCAL');
    expect(routedOneShotWithStop).not.toHaveBeenCalled();
  });

  it('appends a relative input_path inside an <input> block', async () => {
    writeFileSync(path.join(tmp, 'notes.txt'), 'line one\nline two');
    await createModelCompleteHandler(tmp)(
      { prompt: 'summarize this', input_path: 'notes.txt' },
      signal(),
      { resolveBase: tmp },
    );
    const user = routedOneShotWithStop.mock.calls[0]?.[0].user as string;
    expect(user.startsWith('summarize this\n\n<input path="notes.txt">')).toBe(true);
    expect(user).not.toContain(tmp);
    expect(user).toContain('line one\nline two\n</input>');
  });

  it('enforces read-root containment on input_path', async () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), 'afk-model-complete-out-'));
    try {
      writeFileSync(path.join(outside, 'secret.txt'), 'nope');
      const res = await createModelCompleteHandler(tmp)(
        { prompt: 'x', input_path: path.join(outside, 'secret.txt') },
        signal(),
        { resolveBase: tmp },
      );
      expect(res.isError).toBe(true);
      expect(routedOneShotWithStop).not.toHaveBeenCalled();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects binary, oversized, and non-file input_path', async () => {
    const handler = createModelCompleteHandler(tmp);
    const ctx = { resolveBase: tmp };
    writeFileSync(path.join(tmp, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42]));
    writeFileSync(path.join(tmp, 'big.txt'), 'a'.repeat(MAX_INPUT_BYTES + 1));
    mkdirSync(path.join(tmp, 'dir'));
    for (const p of ['bin.dat', 'big.txt', 'dir', 'missing.txt']) {
      const res = await handler({ prompt: 'x', input_path: p }, signal(), ctx);
      expect(res.isError, p).toBe(true);
    }
    expect(routedOneShotWithStop).not.toHaveBeenCalled();
  });

  it('redacts secrets from provider errors', async () => {
    routedOneShotWithStop.mockRejectedValue(new Error('401 bad key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'));
    const res = await createModelCompleteHandler(tmp)({ prompt: 'x' }, signal());
    expect(res.isError).toBe(true);
    expect(res.content).toContain('qwen-test-27b (openai-compatible) failed');
    expect(res.content).not.toContain('sk-ant-api03-AAAA');
  });

  it('reports a caller abort as aborted', async () => {
    const ac = new AbortController();
    routedOneShotWithStop.mockImplementation(async () => {
      ac.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const res = await createModelCompleteHandler(tmp)({ prompt: 'x' }, ac.signal);
    expect(res).toMatchObject({ isError: true, content: 'model_complete: aborted.' });
  });

  it('flags an empty reply and truncates an oversized one', async () => {
    const handler = createModelCompleteHandler(tmp);
    routedOneShotWithStop.mockResolvedValueOnce({ text: '', stopReason: 'end' });
    expect((await handler({ prompt: 'x' }, signal())).content).toBe(
      '(empty reply; try a larger max_tokens if this is a reasoning model)\n\n[model_complete: qwen-test-27b via openai-compatible]',
    );
    routedOneShotWithStop.mockResolvedValueOnce({ text: 'z'.repeat(MAX_REPLY_CHARS + 10), stopReason: 'end' });
    const res = await handler({ prompt: 'x' }, signal());
    expect(res.truncated).toBe(true);
    expect(res.content).toContain(`[truncated at ${MAX_REPLY_CHARS} chars]`);
  });

  it('preserves the max_tokens note for an empty reply', async () => {
    routedOneShotWithStop.mockResolvedValueOnce({ text: '', stopReason: 'max_tokens' });
    const res = await createModelCompleteHandler(tmp)({ prompt: 'x' }, signal());
    expect(res.content).toBe(
      '(empty reply; try a larger max_tokens if this is a reasoning model)' +
      '\n\n[stopped at max_tokens: output may be incomplete; retry with a larger max_tokens]' +
      '\n\n[model_complete: qwen-test-27b via openai-compatible]',
    );
  });

  it('appends the max_tokens note when stopReason is max_tokens', async () => {
    routedOneShotWithStop.mockResolvedValueOnce({ text: 'partial output cut mid', stopReason: 'max_tokens' });
    const res = await createModelCompleteHandler(tmp)({ prompt: 'x' }, signal());
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain('partial output cut mid');
    expect(res.content).toContain('[stopped at max_tokens: output may be incomplete; retry with a larger max_tokens]');
    expect(res.content).toContain('[model_complete:');
  });

  it('does NOT append the max_tokens note when stopReason is end', async () => {
    routedOneShotWithStop.mockResolvedValueOnce({ text: 'complete answer', stopReason: 'end' });
    const res = await createModelCompleteHandler(tmp)({ prompt: 'x' }, signal());
    expect(res.content).not.toContain('stopped at max_tokens');
    expect(res.content).toContain('complete answer');
  });

  it('appends the max_tokens note even when the reply is also char-truncated', async () => {
    routedOneShotWithStop.mockResolvedValueOnce({ text: 'z'.repeat(MAX_REPLY_CHARS + 10), stopReason: 'max_tokens' });
    const res = await createModelCompleteHandler(tmp)({ prompt: 'x' }, signal());
    expect(res.truncated).toBe(true);
    expect(res.content).toContain('[stopped at max_tokens: output may be incomplete; retry with a larger max_tokens]');
  });
});
