/**
 * Tests for judge/index.ts — resolveJudge fallback logic.
 */

import { describe, it, expect, vi } from 'vitest';
import { resolveJudge } from './index.js';
import type { CompleteFn } from '../types.js';
import type { connectJev } from './jev-connect.js';

const MODEL = 'claude-haiku-4-5-20250929';
const complete: CompleteFn = vi.fn().mockResolvedValue({ text: '{}', costUsd: 0 });

const fakeJevConn = {
  callTool: vi.fn().mockResolvedValue({ content: '{}' }),
  close: vi.fn().mockResolvedValue(undefined),
};

const connectJevSuccess: typeof connectJev = async () => fakeJevConn;
const connectJevFail: typeof connectJev = async () => undefined;
const connectJevThrows: typeof connectJev = async () => {
  throw new Error('network error');
};

describe('resolveJudge', () => {
  it("'claude' returns claude judge regardless of jev", async () => {
    const judge = await resolveJudge('claude', { complete, model: MODEL, connectJev: connectJevFail });
    expect(judge.name).toBe('claude');
    expect(judge.external).toBe(false);
  });

  it("'auto' returns jev when connectJev succeeds", async () => {
    const judge = await resolveJudge('auto', { complete, model: MODEL, connectJev: connectJevSuccess });
    expect(judge.name).toBe('jev');
    expect(judge.external).toBe(true);
  });

  it("'auto' falls back to claude when connectJev returns undefined", async () => {
    const judge = await resolveJudge('auto', { complete, model: MODEL, connectJev: connectJevFail });
    expect(judge.name).toBe('claude');
  });

  it("'auto' falls back to claude when connectJev throws", async () => {
    const judge = await resolveJudge('auto', { complete, model: MODEL, connectJev: connectJevThrows });
    expect(judge.name).toBe('claude');
  });

  it("'jev' throws a clear error when unavailable", async () => {
    await expect(
      resolveJudge('jev', { complete, model: MODEL, connectJev: connectJevFail }),
    ).rejects.toThrow(/jev.*not configured|not configured.*jev/i);
  });

  it("'jev' succeeds when connectJev returns a connection", async () => {
    const judge = await resolveJudge('jev', { complete, model: MODEL, connectJev: connectJevSuccess });
    expect(judge.name).toBe('jev');
  });

  it('jev judge from resolveJudge has close() from connection', async () => {
    const judge = await resolveJudge('jev', { complete, model: MODEL, connectJev: connectJevSuccess });
    expect(judge.close).toBeDefined();
  });
});
