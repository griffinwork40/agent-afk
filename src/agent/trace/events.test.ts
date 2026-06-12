/**
 * Tests for the Zod event-payload schemas.
 *
 * These tests are the executable form of the per-event taxonomy in
 * `docs/philosophy/afk-contract.md`. If a schema changes shape, this
 * file changes too — and the diff is the audit trail for the contract.
 */

import { describe, expect, it } from 'vitest';

import {
  AbortPayloadSchema,
  BudgetPayloadSchema,
  ClaimPayloadSchema,
  ClosurePayloadSchema,
  CompactionPayloadInputSchema,
  CompactionPayloadPersistedSchema,
  HookDecisionPayloadSchema,
  SessionSealedPayloadSchema,
  SubagentLifecyclePayloadSchema,
  ToolCallPayloadSchema,
  TraceEventInputSchema,
  TraceEventSchema,
} from './events.js';

describe('tool_call payload', () => {
  it('accepts started phase', () => {
    expect(() =>
      ToolCallPayloadSchema.parse({
        phase: 'started',
        toolUseId: 't1',
        name: 'bash',
        inputBytes: 100,
      }),
    ).not.toThrow();
  });

  it('accepts completed phase with all fields', () => {
    expect(() =>
      ToolCallPayloadSchema.parse({
        phase: 'completed',
        toolUseId: 't1',
        name: 'bash',
        resultBytes: 1024,
        isError: false,
        truncated: false,
        durationMs: 50,
      }),
    ).not.toThrow();
  });

  it('accepts completed phase with a valid failureClass', () => {
    for (const failureClass of ['policy-refusal', 'timeout', 'permission-denied', 'hook-block', 'abort']) {
      expect(() =>
        ToolCallPayloadSchema.parse({
          phase: 'completed',
          toolUseId: 't1',
          name: 'browser_open',
          resultBytes: 64,
          isError: true,
          truncated: false,
          durationMs: 5,
          failureClass,
        }),
      ).not.toThrow();
    }
  });

  it('rejects an unknown failureClass', () => {
    expect(() =>
      ToolCallPayloadSchema.parse({
        phase: 'completed',
        toolUseId: 't1',
        name: 'bash',
        resultBytes: 0,
        isError: true,
        truncated: false,
        durationMs: 1,
        failureClass: 'made-up-class',
      }),
    ).toThrow();
  });

  it('rejects unknown phase', () => {
    expect(() =>
      ToolCallPayloadSchema.parse({
        phase: 'pending',
        toolUseId: 't1',
        name: 'bash',
        inputBytes: 0,
      }),
    ).toThrow();
  });

  it('rejects negative byte counts', () => {
    expect(() =>
      ToolCallPayloadSchema.parse({
        phase: 'started',
        toolUseId: 't1',
        name: 'bash',
        inputBytes: -1,
      }),
    ).toThrow();
  });
});

describe('hook_decision payload', () => {
  it('accepts a block decision with reason and blockedTool', () => {
    expect(() =>
      HookDecisionPayloadSchema.parse({
        hookEvent: 'PreToolUse',
        decision: 'block',
        reason: 'plan-mode',
        blockedTool: 'write_file',
      }),
    ).not.toThrow();
  });

  it('accepts undefined decision (no handler intervened)', () => {
    expect(() =>
      HookDecisionPayloadSchema.parse({
        hookEvent: 'PostToolUse',
        decision: undefined,
      }),
    ).not.toThrow();
  });

  it('rejects unknown hookEvent', () => {
    expect(() =>
      HookDecisionPayloadSchema.parse({
        hookEvent: 'BogusEvent',
        decision: 'block',
      }),
    ).toThrow();
  });
});

describe('subagent_lifecycle payload', () => {
  it('accepts started variant', () => {
    expect(() =>
      SubagentLifecyclePayloadSchema.parse({
        transition: 'started',
        subagentId: 'child-1',
        parentId: 'root',
        model: 'claude-sonnet-4',
      }),
    ).not.toThrow();
  });

  it('accepts cancelled variant with source discriminant', () => {
    expect(() =>
      SubagentLifecyclePayloadSchema.parse({
        transition: 'cancelled',
        subagentId: 'child-1',
        source: 'cascade',
      }),
    ).not.toThrow();
  });

  it('rejects mixed-shape payload', () => {
    expect(() =>
      SubagentLifecyclePayloadSchema.parse({
        transition: 'started',
        subagentId: 'child-1',
        // missing parentId + model
      }),
    ).toThrow();
  });
});

describe('budget payload', () => {
  it('accepts monetary kind', () => {
    expect(() =>
      BudgetPayloadSchema.parse({
        kind: 'monetary',
        runningCostUsd: 0.5,
        maxBudgetUsd: 1.0,
        lastTurnCostUsd: 0.1,
      }),
    ).not.toThrow();
  });

  it('rejects unknown kind (structural limits are not budget events)', () => {
    expect(() =>
      BudgetPayloadSchema.parse({
        kind: 'turns',
        runningCostUsd: 0,
        maxBudgetUsd: 0,
        lastTurnCostUsd: 0,
      }),
    ).toThrow();
  });
});

describe('abort payload', () => {
  it('accepts cascade with empty cascadedTo', () => {
    expect(() =>
      AbortPayloadSchema.parse({ origin: 'cascade', cascadedTo: [] }),
    ).not.toThrow();
  });

  it('accepts user_signal with cascaded ids', () => {
    expect(() =>
      AbortPayloadSchema.parse({
        origin: 'user_signal',
        cascadedTo: ['child-a', 'child-b'],
        reason: 'user pressed ctrl-c',
      }),
    ).not.toThrow();
  });

  it('rejects unknown origin', () => {
    expect(() =>
      AbortPayloadSchema.parse({ origin: 'mystery', cascadedTo: [] }),
    ).toThrow();
  });
});

describe('compaction payload', () => {
  it('input form accepts inline messages array', () => {
    expect(() =>
      CompactionPayloadInputSchema.parse({
        trigger: 'manual',
        preCompactionMessages: [{ role: 'user', content: 'x' }],
        summary: 'summary',
        keptTailCount: 1,
        keepLastNConfig: 3,
        messagesBefore: 5,
        messagesAfter: 2,
      }),
    ).not.toThrow();
  });

  it('persisted form requires sidecar reference', () => {
    expect(() =>
      CompactionPayloadPersistedSchema.parse({
        trigger: 'manual',
        preCompactionMessagesRef: {
          path: '/tmp/x.json',
          sizeBytes: 100,
          sha256: 'a'.repeat(64),
        },
        summary: 'summary',
        keptTailCount: 1,
        keepLastNConfig: 3,
        messagesBefore: 5,
        messagesAfter: 2,
      }),
    ).not.toThrow();
  });

  it('persisted form rejects non-sha256 hash', () => {
    expect(() =>
      CompactionPayloadPersistedSchema.parse({
        trigger: 'manual',
        preCompactionMessagesRef: {
          path: '/tmp/x.json',
          sizeBytes: 100,
          sha256: 'not-a-hash',
        },
        summary: '',
        keptTailCount: 0,
        keepLastNConfig: 0,
        messagesBefore: 0,
        messagesAfter: 0,
      }),
    ).toThrow();
  });
});

describe('closure payload', () => {
  it('accepts max_turns_exceeded reason', () => {
    expect(() =>
      ClosurePayloadSchema.parse({
        reason: 'max_turns_exceeded',
        finalTurnCount: 50,
        finalCostUsd: 5,
        finalTokens: {},
      }),
    ).not.toThrow();
  });

  it('rejects unknown reason', () => {
    expect(() =>
      ClosurePayloadSchema.parse({
        reason: 'finished',
        finalTurnCount: 1,
        finalCostUsd: 0,
        finalTokens: {},
      }),
    ).toThrow();
  });
});

describe('claim payload', () => {
  it('accepts a minimal claim', () => {
    expect(() =>
      ClaimPayloadSchema.parse({
        source: 'verifier-1',
        assertion: 'X holds',
        evidence: ['file.ts:42'],
        confidence: 0.8,
      }),
    ).not.toThrow();
  });

  it('rejects confidence outside [0,1]', () => {
    expect(() =>
      ClaimPayloadSchema.parse({
        source: 'x',
        assertion: 'y',
        evidence: [],
        confidence: 1.5,
      }),
    ).toThrow();
  });
});

describe('session_sealed payload', () => {
  it('accepts a sealed-clean record', () => {
    expect(() =>
      SessionSealedPayloadSchema.parse({
        status: 'succeeded',
        finalCostUsd: 0.1,
        finalTurnCount: 3,
        closedAt: '2026-05-17T12:00:00.000Z',
      }),
    ).not.toThrow();
  });

  it('rejects non-ISO closedAt', () => {
    expect(() =>
      SessionSealedPayloadSchema.parse({
        status: 'succeeded',
        finalCostUsd: 0,
        finalTurnCount: 0,
        closedAt: 'yesterday',
      }),
    ).toThrow();
  });
});

describe('TraceEventInputSchema (whole-event)', () => {
  it('accepts every kind in the contract', () => {
    const kinds = [
      {
        kind: 'tool_call' as const,
        payload: {
          phase: 'started' as const,
          toolUseId: 't',
          name: 'b',
          inputBytes: 0,
        },
      },
      {
        kind: 'hook_decision' as const,
        payload: { hookEvent: 'PreToolUse' as const, decision: undefined },
      },
      {
        kind: 'subagent_lifecycle' as const,
        payload: {
          transition: 'started' as const,
          subagentId: 'c',
          parentId: 'p',
          model: 'm',
        },
      },
      {
        kind: 'budget' as const,
        payload: {
          kind: 'monetary' as const,
          runningCostUsd: 0,
          maxBudgetUsd: 1,
          lastTurnCostUsd: 0,
        },
      },
      {
        kind: 'abort' as const,
        payload: { origin: 'user_signal' as const, cascadedTo: [] },
      },
      {
        kind: 'compaction' as const,
        payload: {
          trigger: 'manual' as const,
          preCompactionMessages: [],
          summary: '',
          keptTailCount: 0,
          keepLastNConfig: 0,
          messagesBefore: 0,
          messagesAfter: 0,
        },
      },
      {
        kind: 'closure' as const,
        payload: {
          reason: 'model_end_turn' as const,
          finalTurnCount: 1,
          finalCostUsd: 0,
          finalTokens: {},
        },
      },
      {
        kind: 'claim' as const,
        payload: {
          source: 's',
          assertion: 'a',
          evidence: [],
          confidence: 0.5,
        },
      },
    ];
    for (const event of kinds) {
      expect(() => TraceEventInputSchema.parse(event)).not.toThrow();
    }
  });

  it('rejects session_sealed in input form (writer-owned)', () => {
    expect(() =>
      TraceEventInputSchema.parse({
        kind: 'session_sealed',
        payload: {
          status: 'succeeded',
          finalCostUsd: 0,
          finalTurnCount: 0,
          closedAt: new Date().toISOString(),
        },
      }),
    ).toThrow();
  });
});

describe('TraceEventSchema (persisted form)', () => {
  it('accepts a persisted event with ts + seq + persisted compaction', () => {
    expect(() =>
      TraceEventSchema.parse({
        ts: '2026-05-17T12:00:00.000Z',
        seq: 0,
        kind: 'compaction',
        payload: {
          trigger: 'manual',
          preCompactionMessagesRef: {
            path: '/tmp/x.json',
            sizeBytes: 1,
            sha256: 'b'.repeat(64),
          },
          summary: '',
          keptTailCount: 0,
          keepLastNConfig: 0,
          messagesBefore: 0,
          messagesAfter: 0,
        },
      }),
    ).not.toThrow();
  });

  it('accepts a persisted session_sealed event', () => {
    expect(() =>
      TraceEventSchema.parse({
        ts: '2026-05-17T12:00:00.000Z',
        seq: 0,
        kind: 'session_sealed',
        payload: {
          status: 'succeeded',
          finalCostUsd: 0,
          finalTurnCount: 0,
          closedAt: '2026-05-17T12:00:00.000Z',
        },
      }),
    ).not.toThrow();
  });

  it('rejects a persisted event missing ts/seq', () => {
    expect(() =>
      TraceEventSchema.parse({
        kind: 'claim',
        payload: {
          source: 's',
          assertion: 'a',
          evidence: [],
          confidence: 1,
        },
      }),
    ).toThrow();
  });
});
