/**
 * Unit tests for scheduler.overlap-guard — focused on secret redaction in
 * makeSessionStartSkipRecord (Item 1 of PR #2320).
 */

import { describe, it, expect } from 'vitest';
import { makeSessionStartSkipRecord } from './scheduler.overlap-guard.js';
import type { ScheduledTask } from './triggers.js';
import type { GateDecision } from './gates.js';

describe('makeSessionStartSkipRecord — secret redaction', () => {
  const nowMs = Date.now();

  const baseTask: ScheduledTask = {
    taskId: 'redact-test',
    trigger: 'sessionstart',
    cronExpression: undefined,
    command: '',
    executor: 'agent',
  };

  const decision: GateDecision = {
    fire: false,
    skipReason: 'cooldown',
  };

  it('redacts an OpenAI-style secret token from the command field', () => {
    // The sk- pattern requires ≥20 chars after "sk-" (see prompt-dump.ts INLINE_SECRET_PATTERNS).
    // "sk-proj-" + 20 alphanum chars satisfies the minimum; a realistic token is longer.
    const rawSecret = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
    const task: ScheduledTask = { ...baseTask, command: `deploy --token ${rawSecret}` };

    const record = makeSessionStartSkipRecord(task, decision, nowMs);

    expect(record.command).not.toContain(rawSecret);
    expect(record.command).toMatch(/REDACTED/i);
  });

  it('preserves commands that contain no secrets', () => {
    const safeCommand = 'run-health-check --env staging';
    const task: ScheduledTask = { ...baseTask, command: safeCommand };

    const record = makeSessionStartSkipRecord(task, decision, nowMs);

    expect(record.command).toBe(safeCommand);
  });

  it('redacts an Anthropic API key (sk-ant-…) in the command field', () => {
    const rawSecret =
      'sk-ant-api03-abc123XYZABC123xyz-0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000XXXX';
    const task: ScheduledTask = {
      ...baseTask,
      command: `deploy --anthropic-key ${rawSecret}`,
    };

    const record = makeSessionStartSkipRecord(task, decision, nowMs);

    expect(record.command).not.toContain(rawSecret);
    expect(record.command).toMatch(/REDACTED/i);
  });

  it('populates skipReason from the gate decision', () => {
    const task: ScheduledTask = { ...baseTask, command: 'noop' };
    const record = makeSessionStartSkipRecord(task, { fire: false, skipReason: 'cooldown' }, nowMs);

    expect(record.skipReason).toBe('cooldown');
    expect(record.status).toBe('skipped');
    expect(record.trigger).toBe('sessionstart');
  });

  it('omits skipReason when the gate decision provides none', () => {
    const task: ScheduledTask = { ...baseTask, command: 'noop' };
    const record = makeSessionStartSkipRecord(task, { fire: false }, nowMs);

    expect(record.skipReason).toBeUndefined();
  });
});
