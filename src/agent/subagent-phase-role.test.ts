/**
 * Regression tests for ForkSubagentOptions.phaseRole — enforced read-only
 * permission boundary for orchestration-skill phases (e.g. mint spec/research/
 * plan) that must not mutate the repo before user approval.
 *
 * Background:
 *   A previous /mint run allowed the spec-phase subagent to write files, commit,
 *   and push because forkSubagent had no per-phase permission boundary. A
 *   `tools.allowedTools` field on AgentConfig.tools is read ONLY by
 *   `emitSubagentLifecycle` for telemetry (subagent.ts:380-382) — it does not
 *   reach the dispatcher. The actual permission gate lives in the provider's
 *   `permissions` field, consumed by `SessionToolDispatcher.checkToolPermission`
 *   (dispatcher.ts:348).
 *
 * These tests prove the wiring from `forkSubagent({phaseRole: 'read-only'})`
 * → `childConfig.provider` → provider.permissions → dispatcher rejection.
 *
 * On current main (before the fix) these tests FAIL because:
 *   (a) `phaseRole` is not a recognized field on ForkSubagentOptions
 *   (b) `READ_ONLY_PHASE_TOOLS` is not exported from `tool-category.ts`
 *   (c) `forkSubagent` does not inject a provider when phaseRole is set
 *
 * After the fix they all pass.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Message } from './types.js';

type CapturedConfig = Record<string, unknown> | null;

interface SessionState {
  config: Record<string, unknown>;
}

const shared = vi.hoisted(() => ({
  lastConfig: null as CapturedConfig,
  sessions: [] as Array<{ state: SessionState }>,
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
      this.sessionId = (config.sessionId as string | undefined) ?? 'child-session-id';
      shared.sessions.push({ state: { config } });
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
      const ctrl = new AbortController();
      return ctrl.signal;
    }
  }
  return { AgentSession: MockAgentSession };
});

import { SubagentManager } from './subagent.js';
import { SessionToolDispatcher } from './tools/dispatcher.js';
import { builtinToolSchemas, agentTool, skillTool } from './tools/schemas.js';
import type { ToolHandler } from './tools/types.js';
// READ_ONLY_PHASE_TOOLS does not exist on main — its absence is part of the
// surface this test pins. After the fix, it's exported from tool-category.ts.
import { READ_ONLY_PHASE_TOOLS } from './tool-category.js';
import { AWARENESS_TOOL_NAMES } from './awareness/tool.js';

function noopHandler(): ToolHandler {
  return async () => ({ content: 'ok' });
}

describe('forkSubagent({phaseRole}) — enforced read-only permission boundary', () => {
  describe('wiring: forkSubagent → childConfig.provider → provider.permissions', () => {
    it('READ_ONLY_PHASE_TOOLS is exported and contains read-only tool names', () => {
      // FAILS on main: symbol does not exist.
      expect(Array.isArray(READ_ONLY_PHASE_TOOLS)).toBe(true);
      // Must include the canonical read-only set.
      expect(READ_ONLY_PHASE_TOOLS).toEqual(
        expect.arrayContaining(['read_file', 'glob', 'grep', 'list_directory', 'memory_search']),
      );
      // Awareness introspection is read-only in-memory — included so phase-restricted
      // forks can orient. Regression guard for the offered-but-rejected get_runtime_state bug.
      expect(READ_ONLY_PHASE_TOOLS).toEqual(expect.arrayContaining([...AWARENESS_TOOL_NAMES]));
      expect(READ_ONLY_PHASE_TOOLS).toContain('get_runtime_state');
      // Must EXCLUDE every write/shell/dispatch tool.
      for (const denied of [
        'write_file',
        'edit_file',
        'bash',
        'agent',
        'skill',
        'compose',
        'memory_update',
        'procedure_write',
        'send_telegram',
      ]) {
        expect(READ_ONLY_PHASE_TOOLS).not.toContain(denied);
      }
    });

    it('phaseRole: "read-only" injects a provider into childConfig.provider', async () => {
      // FAILS on main: phaseRole is not a recognized field, no provider injected.
      shared.lastConfig = null;
      const mgr = new SubagentManager();
      await mgr.forkSubagent({
        parent: { sessionId: 'parent' },
        config: { model: 'sonnet', apiKey: 'k' },
        // `as any` because phaseRole does not exist on ForkSubagentOptions on main.
        // After the fix, this is a typed field.
        phaseRole: 'read-only',
      } as Parameters<SubagentManager['forkSubagent']>[0]);

      const childConfig = shared.lastConfig;
      expect(childConfig).not.toBeNull();
      // The injected provider — present only after the fix.
      const provider = (childConfig as { provider?: unknown }).provider;
      expect(provider).toBeDefined();
    });

    it('the injected provider has READ_ONLY_PHASE_TOOLS as its permissions allowlist', async () => {
      // FAILS on main: no provider is injected, so permissions are not pinned.
      shared.lastConfig = null;
      const mgr = new SubagentManager();
      await mgr.forkSubagent({
        parent: { sessionId: 'parent' },
        config: { model: 'sonnet', apiKey: 'k' },
        phaseRole: 'read-only',
      } as Parameters<SubagentManager['forkSubagent']>[0]);

      const provider = (shared.lastConfig as { provider?: { permissions?: { allowedTools?: string[] } } } | null)
        ?.provider;
      expect(provider).toBeDefined();
      expect(provider?.permissions).toBeDefined();
      expect(provider?.permissions?.allowedTools).toEqual(
        expect.arrayContaining([
          'read_file', 'glob', 'grep', 'list_directory', 'memory_search', 'get_runtime_state',
        ]),
      );
      // Critical: write/shell/dispatch tools must be absent from the allowlist.
      for (const denied of ['write_file', 'edit_file', 'bash', 'agent', 'skill']) {
        expect(provider?.permissions?.allowedTools).not.toContain(denied);
      }
    });

    it('phaseRole: "read-write" (or omitted) does NOT inject a phase-restricted provider', async () => {
      // Backward-compat: existing callers without phaseRole keep working.
      shared.lastConfig = null;
      const mgr = new SubagentManager();
      await mgr.forkSubagent({
        parent: { sessionId: 'parent' },
        config: { model: 'sonnet', apiKey: 'k' },
        // No phaseRole — current default.
      });

      const childConfig = shared.lastConfig as { provider?: unknown } | null;
      // The provider field should NOT be set by the manager when no phaseRole given.
      expect(childConfig?.provider).toBeUndefined();
    });

    it('phaseRole: "read-only" + explicit config.provider is a contract violation (throws)', async () => {
      // If a caller wants to inject their own provider, they must NOT also
      // claim a phaseRole — the two are mutually exclusive.
      const mgr = new SubagentManager();
      const stubProvider = {
        name: 'stub',
        query: () => ({}) as never,
      };
      await expect(
        mgr.forkSubagent({
          parent: { sessionId: 'parent' },
          config: { model: 'sonnet', apiKey: 'k', provider: stubProvider as never },
          phaseRole: 'read-only',
        } as Parameters<SubagentManager['forkSubagent']>[0]),
      ).rejects.toThrow(/phaseRole.*provider/i);
    });
  });

  describe('enforcement: dispatcher rejects write tools given READ_ONLY_PHASE_TOOLS', () => {
    // These tests exercise the REAL dispatcher (src/agent/tools/dispatcher.ts)
    // with the SAME permissions config the phase-restricted provider builds.
    // They prove that the permission gate at dispatcher.ts:348 (checkToolPermission)
    // actually rejects write/shell/dispatch tools when given this allowlist.

    function makeReadOnlyDispatcher(): SessionToolDispatcher {
      // Build a dispatcher with handlers for every blocked tool so we can
      // verify rejection comes from the PERMISSION GATE, not "unknown tool".
      const handlers = new Map<string, ToolHandler>([
        ['write_file', noopHandler()],
        ['edit_file', noopHandler()],
        ['bash', noopHandler()],
        ['agent', noopHandler()],
        ['skill', noopHandler()],
        ['memory_update', noopHandler()],
        ['procedure_write', noopHandler()],
        ['send_telegram', noopHandler()],
        ['read_file', noopHandler()],
        ['glob', noopHandler()],
        ['grep', noopHandler()],
        ['list_directory', noopHandler()],
        ['memory_search', noopHandler()],
        ['get_runtime_state', noopHandler()],
      ]);
      return new SessionToolDispatcher({
        handlers,
        schemas: [...builtinToolSchemas, agentTool, skillTool],
        permissions: { allowedTools: READ_ONLY_PHASE_TOOLS },
      });
    }

    function makeCall(name: string) {
      return {
        id: `test-${name}`,
        name,
        input: {} as Record<string, unknown>,
        signal: new AbortController().signal,
      };
    }

    it.each([
      'write_file',
      'edit_file',
      'bash',
      'agent',
      'skill',
      'memory_update',
      'procedure_write',
      'send_telegram',
    ])('rejects "%s" via permission gate (not unknown-tool path)', async (toolName) => {
      const dispatcher = makeReadOnlyDispatcher();
      const result = await dispatcher.execute(makeCall(toolName));
      expect(result.isError).toBe(true);
      // Specifically the allowlist rejection, not "Unknown tool" or other.
      expect(result.content).toMatch(/not in the configured allowlist/);
    });

    it.each(['read_file', 'glob', 'grep', 'list_directory', 'memory_search', 'get_runtime_state'])(
      'allows "%s" (passes the permission gate)',
      async (toolName) => {
        const dispatcher = makeReadOnlyDispatcher();
        const result = await dispatcher.execute(makeCall(toolName));
        // The handler may or may not error — but the permission gate
        // must NOT reject. We assert specifically that the rejection
        // message is absent.
        if (result.isError) {
          expect(result.content).not.toMatch(/not in the configured allowlist/);
        }
      },
    );
  });
});
