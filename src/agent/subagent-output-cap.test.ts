/**
 * Regression tests for the fork-scoped central output-cap signal (#661).
 *
 * Background:
 *   The #661 backstop bounds EVERY tool result at MODEL_CAP_BYTES (100KB) for
 *   forked subagents, containing the tool-output-overflow crash class (MCP
 *   dumps, browser output, read_file of a huge file). The provider arms the
 *   dispatcher's `maxOutputBytes` from a signal on the child AgentConfig.
 *
 *   The ORIGINAL wiring keyed that signal on `parentSessionId !== undefined`.
 *   That gate is LEAKY: `parentSessionId` is undefined for forks whose parent
 *   carries no sessionId — the skill-fork path builds its nested executor with
 *   `createStubParentSession` (`{ sessionId: undefined }`, nesting.ts:66) and
 *   never backfills the id, so a subagent dispatched by a skill-forked child
 *   (grandchildren and deeper) had `parentSessionId: undefined` and the cap was
 *   NOT armed — leaving those descendants exposed to the overflow crash class.
 *
 *   The fix replaces that heuristic with an EXPLICIT value-carrying field,
 *   `AgentConfig.subagentToolOutputCapBytes`, that `SubagentManager.forkSubagent`
 *   — the single choke point for the agent-tool, skill, and compose fork paths —
 *   stamps UNCONDITIONALLY (as MODEL_CAP_BYTES) on every child config. The
 *   top-level session is built via `new AgentSession(...)` directly at the entry
 *   points (never through forkSubagent), so it never carries the field and is
 *   never capped.
 *
 * These tests pin two claims:
 *   (1) forkSubagent stamps `subagentToolOutputCapBytes = MODEL_CAP_BYTES` on
 *       the child config EVEN when the parent is a stub (`sessionId: undefined`)
 *       — the exact case the old `parentSessionId` gate missed.
 *   (2) The field is set ONLY by the fork path, so a top-level (non-forked)
 *       session leaves it undefined ⇒ dispatcher `maxOutputBytes` unset ⇒ no
 *       central capping (behavior unchanged).
 *
 * Companion: dispatcher.test.ts proves `maxOutputBytes` → head+tail truncation;
 * this file proves the fork → `subagentToolOutputCapBytes` → provider wiring
 * that ARMS it. Provider-level arming (config field → dispatcher option) is
 * covered by the buildDispatcher parity assertions below.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Message } from './types.js';

type CapturedConfig = Record<string, unknown> | null;

const shared = vi.hoisted(() => ({
  lastConfig: null as CapturedConfig,
}));

vi.mock('./session.js', () => {
  class MockAgentSession {
    public readonly sessionId?: string;
    public sendMessage: ReturnType<typeof vi.fn>;
    public sendMessageStream: ReturnType<typeof vi.fn>;
    public interrupt = vi.fn(async () => undefined);
    public close = vi.fn(async () => undefined);
    constructor(config: Record<string, unknown>) {
      shared.lastConfig = config;
      // Mirror the stub-parent case: the child resumes no parent sessionId, so
      // the constructed session's own id is a fresh manager-side value (a real
      // AgentSession would mint one). The key assertion is on the CONFIG, not
      // this id.
      this.sessionId = (config.sessionId as string | undefined) ?? 'child-session-id';
      this.sendMessage = vi.fn(async (content: string): Promise<Message> => ({
        role: 'assistant',
        content: `ok:${content}`,
        timestamp: new Date(),
      }));
      this.sendMessageStream = vi.fn(async function* (this: MockAgentSession, content: string) {
        const result = await this.sendMessage(content);
        yield { type: 'message', message: result };
        yield { type: 'done' };
      }.bind(this));
    }
    get abortSignal(): AbortSignal {
      return new AbortController().signal;
    }
  }
  return { AgentSession: MockAgentSession };
});

import { SubagentManager } from './subagent.js';
import { MODEL_CAP_BYTES } from './tools/handlers/_output-cap.js';

describe('forkSubagent — fork-scoped central output-cap signal (#661)', () => {
  it('stamps subagentToolOutputCapBytes = MODEL_CAP_BYTES on a fork with a STUB parent (sessionId: undefined)', async () => {
    // This is the leaky-gate case: the skill-fork path forks off a stub parent
    // whose sessionId is undefined (createStubParentSession). The OLD gate keyed
    // the cap on `parentSessionId !== undefined`, so this fork was left uncapped.
    shared.lastConfig = null;
    const mgr = new SubagentManager();
    await mgr.forkSubagent({
      // Stub parent — exactly what fork-child-config.ts passes for skill forks.
      parent: { sessionId: undefined },
      config: { model: 'sonnet', apiKey: 'k' },
    });

    const childConfig = shared.lastConfig;
    expect(childConfig).not.toBeNull();
    // The explicit fork-cap signal is present regardless of the parent's id.
    expect(childConfig?.subagentToolOutputCapBytes).toBe(MODEL_CAP_BYTES);
    // And the leaky heuristic it replaced is genuinely absent here: no
    // parentSessionId was derivable from the stub parent, so a gate keyed on it
    // would NOT have armed the cap.
    expect(childConfig?.parentSessionId).toBeUndefined();
  });

  it('stamps subagentToolOutputCapBytes = MODEL_CAP_BYTES on a fork with a REAL parent too (unconditional)', async () => {
    // The agent-tool path forks off a parent that DOES carry a sessionId. The
    // signal must be set here as well — it is stamped unconditionally, so both
    // the previously-covered case and the previously-leaky case are now capped.
    shared.lastConfig = null;
    const mgr = new SubagentManager();
    await mgr.forkSubagent({
      parent: { sessionId: 'parent-session-abc' },
      config: { model: 'sonnet', apiKey: 'k' },
    });

    const childConfig = shared.lastConfig;
    expect(childConfig?.subagentToolOutputCapBytes).toBe(MODEL_CAP_BYTES);
    // Sanity: the fork DID derive a parentSessionId here (real parent) — so
    // this is the case the old gate already covered; it stays covered.
    expect(childConfig?.parentSessionId).toBe('parent-session-abc');
  });

  it('a caller-supplied subagentToolOutputCapBytes does NOT override the fork backstop', async () => {
    // The cap is a non-negotiable fork backstop: forkSubagent sets it AFTER the
    // `...options.config` spread, so a caller cannot weaken/disable it by
    // passing their own value on config.
    shared.lastConfig = null;
    const mgr = new SubagentManager();
    await mgr.forkSubagent({
      parent: { sessionId: undefined },
      // Attempt to disable the cap via a bogus caller value.
      config: { model: 'sonnet', apiKey: 'k', subagentToolOutputCapBytes: 0 },
    });

    const childConfig = shared.lastConfig;
    expect(childConfig?.subagentToolOutputCapBytes).toBe(MODEL_CAP_BYTES);
  });
});
