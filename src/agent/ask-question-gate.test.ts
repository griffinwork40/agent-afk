/**
 * Tests for the ask-question PreToolUse gate.
 *
 * Invariants pinned here:
 *   - No elicitation handler → `ask_question` is blocked pre-flight with the
 *     proceed-on-assumption guidance, and the operator notification fires
 *     (park-and-notify parity with the elicitation router's unattended path).
 *   - Handler installed → the gate is a transparent no-op (waiting for an AFK
 *     operator is designed behavior; the router deliberately has no deadline).
 *   - The gate never touches other tools or other hook events.
 *   - Notification is best-effort: a throwing notifier cannot change the
 *     decision; question text is truncated to bound inadvertent exposure.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock the Telegram push primitive before the gate module (which imports it
// for its default notifier) so no test can touch the network.
vi.mock('../telegram/push.js', () => ({
  pushIfConfigured: vi.fn().mockResolvedValue(null),
}));

import { createAskQuestionGate, ASK_QUESTION_GATE_REASON } from './ask-question-gate.js';
import { elicitationRouter } from './elicitation-router.js';
import type { HookContext } from './hooks.js';
import type { ElicitationResult } from './types/sdk-types.js';

function preToolUse(toolName: string, input?: unknown): HookContext {
  return {
    event: 'PreToolUse',
    toolName,
    ...(input !== undefined ? { input } : {}),
  };
}

describe('createAskQuestionGate', () => {
  it('blocks ask_question with guidance when no handler is installed', () => {
    const gate = createAskQuestionGate({ hasHandler: () => false, notify: () => undefined });
    const decision = gate(preToolUse('ask_question', { question: 'Deploy to prod?' }));
    expect(decision.decision).toBe('block');
    expect(decision.reason).toBe(ASK_QUESTION_GATE_REASON);
    // The guidance must instruct the recovery path, not just refuse.
    expect(decision.reason).toContain('state the assumption');
    expect(decision.reason).toContain('Blocked terminal state');
  });

  it('is a no-op when a handler is installed', () => {
    const notify = vi.fn();
    const gate = createAskQuestionGate({ hasHandler: () => true, notify });
    expect(gate(preToolUse('ask_question', { question: 'x' }))).toEqual({});
    expect(notify).not.toHaveBeenCalled();
  });

  it('ignores other tools', () => {
    const notify = vi.fn();
    const gate = createAskQuestionGate({ hasHandler: () => false, notify });
    expect(gate(preToolUse('bash', { command: 'ls' }))).toEqual({});
    expect(notify).not.toHaveBeenCalled();
  });

  it('ignores non-PreToolUse events', () => {
    const gate = createAskQuestionGate({ hasHandler: () => false, notify: () => undefined });
    const stop: HookContext = { event: 'Stop', sessionId: 's' };
    expect(gate(stop)).toEqual({});
  });

  it('notifies the operator with the question text', () => {
    const notify = vi.fn();
    const gate = createAskQuestionGate({ hasHandler: () => false, notify });
    gate(preToolUse('ask_question', { question: 'Which region?' }));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0]?.[0])).toContain('Which region?');
  });

  it('truncates long question text in the notification', () => {
    const notify = vi.fn();
    const gate = createAskQuestionGate({ hasHandler: () => false, notify });
    gate(preToolUse('ask_question', { question: 'q'.repeat(500) }));
    const message = String(notify.mock.calls[0]?.[0]);
    expect(message).toContain('…(truncated)');
    expect(message).not.toContain('q'.repeat(301));
  });

  it('still blocks when the notifier throws', () => {
    const gate = createAskQuestionGate({
      hasHandler: () => false,
      notify: () => {
        throw new Error('push down');
      },
    });
    const decision = gate(preToolUse('ask_question', { question: 'x' }));
    expect(decision.decision).toBe('block');
    expect(decision.reason).toBe(ASK_QUESTION_GATE_REASON);
  });

  it('handles malformed input without crashing', () => {
    const notify = vi.fn();
    const gate = createAskQuestionGate({ hasHandler: () => false, notify });
    const decision = gate(preToolUse('ask_question', 'not-an-object'));
    expect(decision.decision).toBe('block');
    expect(String(notify.mock.calls[0]?.[0])).toContain('(question text unavailable)');
  });

  it('defaults the handler probe to the module elicitationRouter', () => {
    elicitationRouter.uninstall();
    const notify = vi.fn();
    const gate = createAskQuestionGate({ notify });
    expect(gate(preToolUse('ask_question', { question: 'x' })).decision).toBe('block');

    const handler = async (): Promise<ElicitationResult> => ({ action: 'decline' });
    elicitationRouter.install(handler);
    try {
      expect(gate(preToolUse('ask_question', { question: 'x' }))).toEqual({});
    } finally {
      elicitationRouter.uninstall();
    }
  });
});
