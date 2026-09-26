/**
 * Tests for the full-fidelity resume path in buildProviderQuery:
 * - When `config.resumeMessages` is present and non-empty, `filterResumeMessages`
 *   is used to seed `initialMessages` (thinking blocks stripped, unknowns dropped).
 * - When `config.resumeMessages` is absent or empty, falls back to
 *   `resumeHistoryToMessages(config.resumeHistory)`.
 *
 * These tests exercise the seam at the `filterResumeMessages` / `resumeHistoryToMessages`
 * level rather than fully constructing `AnthropicDirectQuery`, mirroring the style
 * of session-state-resume.test.ts — isolated unit tests for the resolution logic.
 *
 * @module agent/providers/anthropic-direct/provider-query-build.resumeMessages.test
 */

import { describe, it, expect } from 'vitest';
import { resolveInitialMessages } from './resolve-params.js';
import type { MessageParam } from '@anthropic-ai/sdk/resources';

describe('resolveInitialMessages (used by buildProviderQuery) — initialMessages resolution (full-fidelity vs. text fallback)', () => {
  it('uses resumeMessages when present and non-empty', () => {
    const resumeMessages: MessageParam[] = [
      { role: 'user', content: 'hello from snapshot' },
      { role: 'assistant', content: 'hi from snapshot' },
    ];
    const result = resolveInitialMessages({ resumeMessages });
    expect(result).toBeDefined();
    expect(result).toHaveLength(2);
    expect((result![0] as MessageParam).content).toBe('hello from snapshot');
  });

  it('strips thinking blocks from resumeMessages', () => {
    const resumeMessages = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'thinking', thinking: 'private thoughts' },
          { type: 'text', text: 'visible reply' },
        ],
      },
    ];
    const result = resolveInitialMessages({ resumeMessages });
    expect(result).toBeDefined();
    const content = (result![0] as MessageParam).content as Array<{ type: string }>;
    expect(content.every((b) => b.type !== 'thinking')).toBe(true);
    expect(content.some((b) => b.type === 'text')).toBe(true);
  });

  it('strips redacted_thinking blocks from resumeMessages', () => {
    const resumeMessages = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'redacted_thinking', data: 'encrypted' },
          { type: 'text', text: 'final answer' },
        ],
      },
    ];
    const result = resolveInitialMessages({ resumeMessages });
    expect(result).toBeDefined();
    const content = (result![0] as MessageParam).content as Array<{ type: string }>;
    expect(content.every((b) => b.type !== 'redacted_thinking')).toBe(true);
  });

  it('falls back to resumeHistoryToMessages when resumeMessages is absent', () => {
    const resumeHistory = [{ user: 'text user', assistant: 'text assistant', inputTokens: 0 }];
    const result = resolveInitialMessages({ resumeHistory });
    expect(result).toBeDefined();
    // resumeHistoryToMessages produces 2 MessageParam per turn (user + assistant).
    expect(result!.length).toBe(2);
    expect((result![0] as MessageParam).role).toBe('user');
    expect((result![1] as MessageParam).role).toBe('assistant');
  });

  it('falls back to resumeHistoryToMessages when resumeMessages is empty array', () => {
    const resumeHistory = [{ user: 'q', assistant: 'a', inputTokens: 0 }];
    const result = resolveInitialMessages({ resumeMessages: [], resumeHistory });
    expect(result).toBeDefined();
    expect((result![0] as MessageParam).role).toBe('user');
  });

  it('falls back to resumeHistoryToMessages when resumeMessages filters to empty (all stripped)', () => {
    // All thinking — nothing survives filterResumeMessages → falls back to text path.
    const resumeMessages = [
      {
        role: 'assistant' as const,
        content: [{ type: 'thinking', thinking: 'thoughts only' }],
      },
    ];
    const resumeHistory = [{ user: 'text', assistant: 'reply', inputTokens: 0 }];
    const result = resolveInitialMessages({ resumeMessages, resumeHistory });
    expect(result).toBeDefined();
    // Must have come from resumeHistoryToMessages (text path).
    expect((result![0] as MessageParam).role).toBe('user');
    expect((result![0] as MessageParam).content).toBe('text');
  });

  it('returns undefined when both resumeMessages and resumeHistory are absent', () => {
    const result = resolveInitialMessages({});
    expect(result).toBeUndefined();
  });

  it('prefers resumeMessages over resumeHistory when both are present', () => {
    const resumeMessages: MessageParam[] = [{ role: 'user', content: 'from snapshot' }];
    const resumeHistory = [{ user: 'from history', assistant: 'old reply', inputTokens: 0 }];
    const result = resolveInitialMessages({ resumeMessages, resumeHistory });
    // Should come from the snapshot, not the history.
    expect((result![0] as MessageParam).content).toBe('from snapshot');
    expect(result!.length).toBe(1); // only 1 from snapshot, not 2 from history
  });
});
