import { describe, expect, it } from 'vitest';
import {
  YIELDABLE_TOOLS,
  isUserWaiting,
  isYieldableTool,
  userAttentionFrom,
  yieldNotice,
  type UserAttention,
} from './user-yield.js';
import { SessionToolDispatcher } from './dispatcher.js';
import { builtinToolSchemas } from './schemas.js';
import { waitForTool } from './schemas.wait-for.js';
import { EXIT_PLAN_MODE_TOOL_NAME } from './handlers/exit-plan-mode.js';
import type { ToolHandler, ToolHandlerContext } from './types.js';

describe('yield contract: YIELDABLE_TOOLS', () => {
  it('pins literal names against the real tool-name constants', () => {
    expect(YIELDABLE_TOOLS.has(waitForTool.name)).toBe(true);
    expect(YIELDABLE_TOOLS.has(EXIT_PLAN_MODE_TOOL_NAME)).toBe(true);
    expect(YIELDABLE_TOOLS.size).toBe(2);
  });

  it('never admits tools whose interruption loses work', () => {
    for (const name of ['bash', 'compose', 'agent', 'skill', 'test_run', 'write_file']) {
      expect(isYieldableTool(name)).toBe(false);
    }
  });
});

describe('yield contract: userAttentionFrom / isUserWaiting', () => {
  it('returns undefined without a holder (subagents, headless)', () => {
    expect(userAttentionFrom(undefined)).toBeUndefined();
    expect(isUserWaiting(undefined)).toBe(false);
  });

  it('is late-bound: honours a predicate installed after construction', () => {
    const holder: { hasPendingUserMessage?: () => boolean } = {};
    const attention = userAttentionFrom(holder);
    expect(isUserWaiting(attention)).toBe(false);
    let queued = false;
    holder.hasPendingUserMessage = () => queued;
    expect(isUserWaiting(attention)).toBe(false);
    queued = true;
    expect(isUserWaiting(attention)).toBe(true);
  });

  it('treats a throwing predicate as "not waiting"', () => {
    const attention: UserAttention = {
      hasPendingUserMessage: () => {
        throw new Error('compositor gone');
      },
    };
    expect(isUserWaiting(attention)).toBe(false);
  });
});

describe('yield contract: yieldNotice', () => {
  it('reproduces the pre-refactor exit_plan_mode text byte-for-byte', () => {
    expect(yieldNotice('You can call exit_plan_mode again afterward.')).toBe(
      'The user has a queued message waiting to be delivered. End your turn now so ' +
        'the message is delivered first. You can call exit_plan_mode again afterward.',
    );
  });
});

describe('yield contract: dispatcher attaches userAttention only to yieldable tools', () => {
  function capture(): { handler: ToolHandler; seen: Array<ToolHandlerContext | undefined> } {
    const seen: Array<ToolHandlerContext | undefined> = [];
    return {
      seen,
      handler: async (_input, _signal, context) => {
        seen.push(context);
        return { content: 'ok' };
      },
    };
  }

  function dispatch(name: string, userAttention?: UserAttention) {
    const probe = capture();
    const dispatcher = new SessionToolDispatcher({
      handlers: new Map([[name, probe.handler]]),
      schemas: [...builtinToolSchemas],
      permissions: { allowedTools: [name] },
      ...(userAttention !== undefined ? { userAttention } : {}),
    });
    return { dispatcher, probe };
  }

  const attention: UserAttention = { hasPendingUserMessage: () => true };
  const call = (name: string) => ({
    id: `id-${name}`,
    name,
    input: {},
    signal: new AbortController().signal,
  });

  it('hands userAttention to wait_for', async () => {
    const { dispatcher, probe } = dispatch('wait_for', attention);
    await dispatcher.execute(call('wait_for'));
    expect(probe.seen[0]?.userAttention).toBe(attention);
  });

  it('never hands userAttention to bash', async () => {
    const { dispatcher, probe } = dispatch('bash', attention);
    await dispatcher.execute(call('bash'));
    expect(probe.seen).toHaveLength(1);
    expect(probe.seen[0]?.userAttention).toBeUndefined();
  });

  it('attaches nothing when the dispatcher has no userAttention (subagents)', async () => {
    const { dispatcher, probe } = dispatch('wait_for');
    await dispatcher.execute(call('wait_for'));
    expect(probe.seen[0]?.userAttention).toBeUndefined();
  });
});
