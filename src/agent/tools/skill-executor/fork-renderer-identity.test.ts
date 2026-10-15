import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SubagentProgressSink } from '../../types/session-types.js';
import { SkillExecutor } from '../skill-executor.js';
import { executePluginSkill } from './fork-dispatch.js';
import { registerSkill, _resetRegistry } from '../../../skills/skill-registry.js';
import { SubagentManager } from '../../subagent.js';
import * as promptLoader from '../../../skills/_lib/prompt-loader.js';
import { runWithSink } from '../../_lib/skill-sink-channel.js';
import { StreamRenderer } from '../../../cli/_lib/stream-renderer.js';
import type { ToolLane } from '../../../cli/commands/interactive/tool-lane.js';

vi.mock('../../auth/credential-resolver.js', () => ({
  resolveCredentialForModel: vi.fn(() => 'test-credential'),
  loadAnthropicCredential: vi.fn(() => 'test-credential'),
  loadOpenAICredential: vi.fn(() => undefined),
}));

afterEach(() => { vi.restoreAllMocks(); _resetRegistry(); });

describe('resolved fork identity reaches renderer-owned tool entries', () => {
  it.each(['registry', 'plugin'] as const)('%s: isolates simultaneous calls and nested failure', async (source) => {
    _resetRegistry();
    vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({ 'system.md': 'Test skill' });
    registerSkill({ name: 'review', description: 'Resolved purpose', context: 'fork', handler: vi.fn() });
    const signal = new AbortController().signal;
    const ctx = {
      parentSession: { sessionId: 'parent', getInputStreamRef: () => ({ pushUserMessage() {} }), abortSignal: signal },
      defaultModel: 'sonnet',
    };
    const sinks: SubagentProgressSink[] = [];
    // Only process spawning is replaced. Metadata resolution, fork-manager construction,
    // ambient sink wrapping, renderer processing and ToolLane are production code.
    vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockImplementation(async function (this: SubagentManager) {
      sinks.push((this as unknown as { progressSink: SubagentProgressSink }).progressSink);
      return {
        id: `child-${sinks.length}`, session: undefined,
        runToResult: async () => ({ status: 'succeeded', message: { content: 'done' } }),
        teardown: async () => {}, getLastStopInjectContext: () => undefined,
      } as unknown as Awaited<ReturnType<SubagentManager['forkSubagent']>>;
    });
    vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);
    const line = vi.fn();
    const renderer = new StreamRenderer({
      forceNonTty: true,
      out: { line, raw: line, info: line, warn: line, error: line, success: line },
    });
    // Inspect actual entries, rather than spying setSkillIdentity (which would
    // pass even if the renderer routed to a missing or wrong tool-call ID).
    const lane = (renderer as unknown as { toolLane: ToolLane }).toolLane;
    const entries = (lane as unknown as { entries: Map<string, { toolInput: string; agentContext?: string }> }).entries;
    const start = (id: string, name: string) => ({
      type: 'chunk' as const,
      chunk: { type: 'tool_use_detail' as const, toolUseId: id, toolName: name, toolInput: '{}' },
    });
    try {
      await renderer.arm();
      renderer.process(start('call-a', 'skill'));
      renderer.process(start('call-b', 'skill'));
      const executor = new SkillExecutor(ctx);
      await runWithSink((event, meta) => renderer.process(event, meta), () => Promise.all(
        ['a', 'b'].map((suffix) => {
          const call = { id: `call-${suffix}`, name: 'skill', input: { name: 'review', arguments: `target-${suffix}` }, signal };
          return source === 'registry' ? executor.execute(call) : executePluginSkill(
            { ctx, currentCwd: undefined }, 'review', 'Test body', '/fake/plugin', `target-${suffix}`,
            call, false, undefined, undefined, 'Resolved purpose',
          );
        }),
      ));
      expect(sinks).toHaveLength(2);
      for (let i = 0; i < 2; i++) {
        const suffix = i === 0 ? 'a' : 'b';
        sinks[i]!(start(`nested-${suffix}`, 'agent'), { subagentId: `child-${suffix}`, parentId: `call-${suffix}` });
      }
      expect(entries.get('call-a')?.toolInput).toContain('Resolved purpose');
      expect(entries.get('call-a')?.toolInput).toContain('target-a');
      expect(entries.get('call-a')?.toolInput).not.toContain('target-b');
      expect(entries.get('call-b')?.toolInput).toContain('target-b');
      expect(entries.get('nested-a')?.toolInput).not.toContain('Resolved purpose');
      const childParent = entries.get('nested-a')?.agentContext;
      expect(childParent).toBe('__synth_agent_child-a');
      expect(entries.get(childParent!)?.agentContext).toBe('call-a');
      const beforeB = entries.get('call-b')?.toolInput;
      sinks[0]!(start('nested-read', 'read_file'), { subagentId: 'grandchild-a', parentId: 'nested-a' });
      expect(entries.get('nested-read')?.agentContext).toBe('nested-a');
      sinks[0]!({ type: 'error', error: new Error('nested failure') }, { subagentId: 'grandchild-a', parentId: 'nested-a' });
      expect(entries.get('call-b')?.toolInput).toBe(beforeB);
      expect(entries.get('call-a')?.toolInput).toContain('target-a');
      expect(line.mock.calls.flat().join('\n')).not.toContain('args: target-b');
    } finally {
      await renderer.dispose();
    }
  });
});
