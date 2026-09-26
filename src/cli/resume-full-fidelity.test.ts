/**
 * End-to-end round-trip for the full-fidelity session-resume feature.
 *
 * stats with messagesSource returning a multi-round tool history (including a
 * thinking block) → saveSession → resolveResumeTarget/resumeConfigFor →
 * filterResumeMessages(config.resumeMessages) equals the original minus the
 * thinking block (thinking and redacted_thinking are stripped on resume).
 *
 * Also verifies:
 *   - resumeConfigFor passes resumeMessages when stored.messages is non-empty.
 *   - resumeMessages is absent for old sidecars (no .messages field).
 *   - filterResumeMessages result matches the original sans thinking blocks.
 *
 * @module cli/resume-full-fidelity.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { MessageParam } from '@anthropic-ai/sdk/resources';
import { saveSession } from './session-store.js';
import { resolveResumeTarget } from './resume-session.js';
import { resumeConfigFor } from './resume-session.js';
import { filterResumeMessages } from '../agent/providers/anthropic-direct/resolve-params.js';
import { createSessionStats, recordTurn } from './slash/session-stats.js';

let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

beforeEach(() => {
  originalHome = process.env['HOME'];
  originalUserProfile = process.env['USERPROFILE'];
  tmpHome = join(tmpdir(), `afk-ff-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env['HOME'] = tmpHome;
  process.env['USERPROFILE'] = tmpHome;
  process.env['AFK_HOME'] = join(tmpHome, '.afk'); // audit-env-access: allow — test isolation
});

afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  if (originalHome !== undefined) process.env['HOME'] = originalHome;
  if (originalUserProfile !== undefined) process.env['USERPROFILE'] = originalUserProfile;
  else delete process.env['USERPROFILE'];
  // Restore AFK_HOME to the test-suite sentinel (vitest redirect-paths-env.ts sets it).
  // If there was no prior value, deleting is correct — the sentinel will be re-set next test.
  delete process.env['AFK_HOME']; // audit-env-access: allow — test isolation cleanup
});

describe('full-fidelity round-trip', () => {
  it('messagesSource with thinking block → saveSession → resumeConfigFor → filterResumeMessages strips thinking', () => {
    // Construct a realistic multi-round tool history that includes a thinking block.
    // The thinking block must NOT survive filterResumeMessages.
    const fullMessages: MessageParam[] = [
      { role: 'user', content: 'run something' },
      {
        role: 'assistant',
        content: [
          // Thinking block — must be stripped by filterResumeMessages.
          { type: 'thinking', thinking: 'let me plan this carefully' } as import('@anthropic-ai/sdk/resources').ContentBlockParam,
          { type: 'text', text: 'I will run bash.' },
          { type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } } as import('@anthropic-ai/sdk/resources').ContentBlockParam,
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'file.ts\nother.ts' } as import('@anthropic-ai/sdk/resources').ContentBlockParam,
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Done.' },
        ],
      },
    ];

    // Wire messagesSource to return the full history.
    const stats = createSessionStats('sonnet');
    recordTurn(stats, 'run something', 'I will run bash. Done.', { sessionId: 'sdk-ff-e2e' });
    stats.messagesSource = () => fullMessages;

    // Save the session — should write .messages to the sidecar.
    saveSession(stats, 'ff-e2e-session');

    // Reload via resumeConfigFor.
    const target = resolveResumeTarget({ resume: 'ff-e2e-session' });
    expect(target).toBeDefined();
    const config = resumeConfigFor(target);

    // resumeMessages must be present (the sidecar has .messages).
    expect(config.resumeMessages).toBeDefined();
    expect(config.resumeMessages!.length).toBeGreaterThan(0);

    // Apply filterResumeMessages (what buildProviderQuery does).
    const filtered = filterResumeMessages(config.resumeMessages!);

    // Same number of messages (no message is entirely dropped here — the
    // assistant turn still has text + tool_use after stripping thinking).
    expect(filtered.length).toBe(fullMessages.length);

    // All roles in the correct order.
    expect(filtered.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);

    // Turn 0: plain user text preserved.
    expect(filtered[0]!.content).toBe('run something');

    // Turn 1: thinking block stripped; text + tool_use kept.
    const t1 = filtered[1]!.content as Array<{ type: string }>;
    expect(t1.every((b) => b.type !== 'thinking')).toBe(true);
    expect(t1.some((b) => b.type === 'text')).toBe(true);
    expect(t1.some((b) => b.type === 'tool_use')).toBe(true);

    // Verify the original had a thinking block that was stripped.
    const origT1 = (fullMessages[1]!.content as Array<{ type: string }>);
    expect(origT1.some((b) => b.type === 'thinking')).toBe(true);
    expect(t1.length).toBe(origT1.length - 1); // thinking block removed

    // Turn 2: tool_result preserved verbatim.
    const t2 = filtered[2]!.content as Array<{ type: string; tool_use_id?: string }>;
    expect(t2[0]!.type).toBe('tool_result');
    expect(t2[0]!.tool_use_id).toBe('tu_1');

    // Turn 3: plain text preserved.
    const t3 = filtered[3]!.content as Array<{ type: string; text?: string }>;
    expect(t3[0]!.type).toBe('text');
    expect(t3[0]!.text).toBe('Done.');
  });

  it('also verifies redacted_thinking is stripped in the same round-trip', () => {
    const fullMessages: MessageParam[] = [
      { role: 'user', content: 'question' },
      {
        role: 'assistant',
        content: [
          { type: 'redacted_thinking', data: 'base64encrypted' } as import('@anthropic-ai/sdk/resources').ContentBlockParam,
          { type: 'text', text: 'answer' },
        ],
      },
    ];

    const stats = createSessionStats('sonnet');
    recordTurn(stats, 'question', 'answer', { sessionId: 'sdk-rt-e2e' });
    stats.messagesSource = () => fullMessages;
    saveSession(stats, 'rt-e2e-session');

    const target = resolveResumeTarget({ resume: 'rt-e2e-session' });
    const config = resumeConfigFor(target);
    expect(config.resumeMessages).toBeDefined();

    const filtered = filterResumeMessages(config.resumeMessages!);
    const t1 = filtered[1]!.content as Array<{ type: string }>;
    expect(t1.every((b) => b.type !== 'redacted_thinking')).toBe(true);
    expect(t1.some((b) => b.type === 'text')).toBe(true);
  });

  it('old sidecars without .messages fall back to resumeHistory (text path)', () => {
    // An old sidecar: no messagesSource → no .messages field → resumeConfigFor
    // must NOT set resumeMessages.
    const stats = createSessionStats('sonnet');
    recordTurn(stats, 'old user', 'old assistant', { sessionId: 'sdk-legacy' });
    // No messagesSource.
    saveSession(stats, 'legacy-session');

    const target = resolveResumeTarget({ resume: 'legacy-session' });
    const config = resumeConfigFor(target);

    expect(config.resumeMessages).toBeUndefined();
    // But resumeHistory must still be present (text fallback).
    expect(config.resumeHistory).toBeDefined();
    expect(config.resumeHistory![0]!.user).toBe('old user');
    expect(config.resumeHistory![0]!.assistant).toBe('old assistant');
  });
});
