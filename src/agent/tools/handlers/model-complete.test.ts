import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

const routedOneShot = vi.fn();
vi.mock('../../providers/shared/one-shot-router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../providers/shared/one-shot-router.js')>();
  return { ...actual, routedOneShot: (...args: unknown[]) => routedOneShot(...args) };
});

import {
  createModelCompleteHandler,
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
  routedOneShot.mockReset();
  routedOneShot.mockResolvedValue('the reply');
  setSlotBindings(LOCAL_SLOTS);
});

afterEach(() => {
  resetSlotBindings();
  rmSync(tmp, { recursive: true, force: true });
});

describe('parseModelCompleteInput', () => {
  it('rejects a missing or blank prompt', () => {
    expect(parseModelCompleteInput({})).toMatchObject({ isError: true });
    expect(parseModelCompleteInput({ prompt: '   ' })).toMatchObject({ isError: true });
  });

  it('defaults model to local and max_tokens to 4096', () => {
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

describe('model_complete handler', () => {
  it('routes the default local slot with its provider, endpoint, and key', async () => {
    const res = await createModelCompleteHandler(tmp)({ prompt: 'summarize' }, signal());
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain('the reply');
    expect(res.content).toContain('[model_complete: qwen-test-27b via openai-compatible]');
    const call = routedOneShot.mock.calls[0]?.[0];
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
    expect(routedOneShot.mock.calls[0]?.[0]).toMatchObject({ model: 'qwen-test-27b' });
    await handler({ prompt: 'b', model: 'haiku', system: 'be terse' }, signal());
    expect(routedOneShot.mock.calls[1]?.[0]).toMatchObject({
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
    expect(routedOneShot).not.toHaveBeenCalled();
  });

  it('appends a relative input_path inside an <input> block', async () => {
    writeFileSync(path.join(tmp, 'notes.txt'), 'line one\nline two');
    await createModelCompleteHandler(tmp)(
      { prompt: 'summarize this', input_path: 'notes.txt' },
      signal(),
      { resolveBase: tmp },
    );
    const user = routedOneShot.mock.calls[0]?.[0].user as string;
    expect(user.startsWith('summarize this\n\n<input path="')).toBe(true);
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
      expect(routedOneShot).not.toHaveBeenCalled();
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
    expect(routedOneShot).not.toHaveBeenCalled();
  });

  it('redacts secrets from provider errors', async () => {
    routedOneShot.mockRejectedValue(new Error('401 bad key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'));
    const res = await createModelCompleteHandler(tmp)({ prompt: 'x' }, signal());
    expect(res.isError).toBe(true);
    expect(res.content).toContain('qwen-test-27b (openai-compatible) failed');
    expect(res.content).not.toContain('sk-ant-api03-AAAA');
  });

  it('reports a caller abort as aborted', async () => {
    const ac = new AbortController();
    routedOneShot.mockImplementation(async () => {
      ac.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const res = await createModelCompleteHandler(tmp)({ prompt: 'x' }, ac.signal);
    expect(res).toMatchObject({ isError: true, content: 'model_complete: aborted.' });
  });

  it('flags an empty reply and truncates an oversized one', async () => {
    const handler = createModelCompleteHandler(tmp);
    routedOneShot.mockResolvedValueOnce('');
    expect((await handler({ prompt: 'x' }, signal())).content).toMatch(/^\(empty reply/);
    routedOneShot.mockResolvedValueOnce('z'.repeat(MAX_REPLY_CHARS + 10));
    const res = await handler({ prompt: 'x' }, signal());
    expect(res.truncated).toBe(true);
    expect(res.content).toContain(`[truncated at ${MAX_REPLY_CHARS} chars]`);
  });
});
