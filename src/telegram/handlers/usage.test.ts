/**
 * Tests for the Telegram `/usage` command handler (handlers/usage.ts).
 *
 * Mocks the sibling module `agent/subscription-usage.js` (fetchSubscriptionUsage
 * never throws in practice — this test only verifies handleUsage wires its
 * result into formatUsage() and replies with the result, plus that a thrown
 * error is caught and surfaced via formatError as a last-resort guard).
 */

import { describe, it, expect, vi } from 'vitest';
import type { Context } from 'telegraf';
import type { UsageResult } from '../../agent/subscription-usage.js';

const mockFetch = vi.fn<() => Promise<UsageResult>>();
vi.mock('../../agent/subscription-usage.js', () => ({
  fetchSubscriptionUsage: (...args: unknown[]) => mockFetch(...(args as [])),
}));

const { handleUsage } = await import('./usage.js');

function makeCtx(): { ctx: Context; replies: string[] } {
  const replies: string[] = [];
  const ctx = {
    chat: { id: 555 },
    reply: (t: string) => {
      replies.push(t);
      return Promise.resolve({ message_id: replies.length });
    },
  };
  return { ctx: ctx as unknown as Context, replies };
}

describe('handleUsage (/usage on Telegram)', () => {
  it('ok with all windows replies with a formatted percentage line per window', async () => {
    const resetsAt = new Date('2026-01-01T00:00:00Z');
    mockFetch.mockResolvedValueOnce({
      kind: 'ok',
      fiveHour: { utilization: 0.5, resetsAt },
      sevenDay: { utilization: 0.3 },
    });
    const { ctx, replies } = makeCtx();

    await handleUsage(ctx, () => {});

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('50%');
    expect(replies[0]).toContain('30%');
    expect(replies[0]).toMatch(/5-hour/);
    expect(replies[0]).toMatch(/7-day/);
  });

  it('ok with only fiveHour replies with just that window', async () => {
    mockFetch.mockResolvedValueOnce({ kind: 'ok', fiveHour: { utilization: 0.9 } });
    const { ctx, replies } = makeCtx();

    await handleUsage(ctx, () => {});

    expect(replies[0]).toContain('90%');
    expect(replies[0]).not.toMatch(/7-day/);
  });

  it('unavailable / no-token tells the operator to run claude login', async () => {
    mockFetch.mockResolvedValueOnce({
      kind: 'unavailable',
      reason: 'no-token',
      detail: 'no credentials found',
    });
    const { ctx, replies } = makeCtx();

    await handleUsage(ctx, () => {});

    expect(replies[0]).toMatch(/claude login/);
  });

  it('a thrown error from fetchSubscriptionUsage is caught and surfaces a generic error reply', async () => {
    mockFetch.mockRejectedValueOnce(new Error('boom'));
    const { ctx, replies } = makeCtx();
    const log = vi.fn();

    await handleUsage(ctx, log);

    expect(replies[0]).toMatch(/Could not fetch usage/);
    expect(log).toHaveBeenCalled();
  });
});
