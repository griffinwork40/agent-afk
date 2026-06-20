/**
 * Tests for SkillExecutor — the provider-level handler for the `skill` tool.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the credential resolver so tests are not coupled to the live
// keychain / environment. Default: returns 'resolved-test-credential' for
// any model.
const mockResolveCredentialForModel = vi.hoisted(() =>
  vi.fn((_model: string | undefined) => 'resolved-test-credential' as string | undefined),
);
vi.mock('../auth/credential-resolver.js', () => ({
  resolveCredentialForModel: mockResolveCredentialForModel,
  loadAnthropicCredential: vi.fn(() => 'resolved-test-credential'),
  loadOpenAICredential: vi.fn(() => undefined),
}));

// Mock writeSkillInvocation so the call-site wiring test can assert it was
// called without performing real I/O (the guard would suppress writes under
// vitest anyway, but mocking is cleaner for assertion purposes).
const mockWriteSkillInvocation = vi.hoisted(() => vi.fn());
vi.mock('../telemetry/skill-invocation-writer.js', () => ({
  writeSkillInvocation: mockWriteSkillInvocation,
}));

import { SkillExecutor } from './skill-executor.js';
import { registerSkill, _resetRegistry } from '../../skills/index.js';
import { SubagentManager } from '../subagent.js';
import * as SubagentExecutorModule from './subagent-executor.js';
import * as promptLoader from '../../skills/_lib/prompt-loader.js';
import * as nestingModule from './nesting.js';
import {
  onTrustedSkillComplete,
  offTrustedSkillComplete,
} from '../_lib/trusted-skill-events.js';
import { registerTrustedSkillName, clearTrustedSkillNamesForTesting } from '../_lib/trusted-skill-registry.js';
import type { TrustedSkillResult } from '../trusted-skill-result.js';
import type { PluginSkillBody } from './skill-bridge.js';
import { RECON_ALLOWED_TOOLS } from './nesting.js';

const abortSignal = new AbortController().signal;

function makeCall(input: unknown) {
  return {
    id: 'test-call',
    name: 'skill',
    input,
    signal: abortSignal,
  };
}

describe('SkillExecutor', () => {
  beforeEach(() => {
    _resetRegistry();
    clearTrustedSkillNamesForTesting();
  });

  afterEach(() => {
    clearTrustedSkillNamesForTesting();
  });

  it('should dispatch a registered skill by name', async () => {
    registerSkill({
      name: 'test-skill',
      description: 'A test skill',
      handler: vi.fn().mockResolvedValue('skill output'),
    });

    const executor = new SkillExecutor({
      parentSession: {
        sessionId: 'test',
        getInputStreamRef: () => ({ pushUserMessage: () => {} }),
        abortSignal,
      },
    });

    const result = await executor.execute(makeCall({ name: 'test-skill', arguments: 'hello' }));
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('skill output');
  });

  it('should pass arguments to the skill handler', async () => {
    const handler = vi.fn().mockResolvedValue('ok');
    registerSkill({ name: 'arg-skill', description: 'test', handler });

    const executor = new SkillExecutor({
      parentSession: {
        sessionId: 'test',
        getInputStreamRef: () => ({ pushUserMessage: () => {} }),
        abortSignal,
      },
    });

    await executor.execute(makeCall({ name: 'arg-skill', arguments: 'my args' }));
    expect(handler).toHaveBeenCalledWith('my args', expect.anything(), expect.any(Object));
  });

  it('should pass apiKey + model defaults via ctx so handlers can fork sub-agents', async () => {
    const handler = vi.fn().mockResolvedValue('ok');
    registerSkill({ name: 'ctx-skill', description: 'test', handler });

    const executor = new SkillExecutor({
      parentSession: {
        sessionId: 'test',
        getInputStreamRef: () => ({ pushUserMessage: () => {} }),
        abortSignal,
      },
      apiKey: 'sk-test-token',
      defaultModel: 'sonnet',
      defaultSubagentModel: 'haiku',
    });

    await executor.execute(makeCall({ name: 'ctx-skill' }));

    expect(handler).toHaveBeenCalledWith(
      undefined,
      expect.anything(),
      expect.objectContaining({
        apiKey: 'sk-test-token',
        defaultModel: 'sonnet',
        defaultSubagentModel: 'haiku',
      }),
    );
  });

  it('passes call.id as ctx.callId so inline handlers can anchor forked subagents', async () => {
    // Regression: without ctx.callId, inline-handler forkSubagent calls fall
    // back to `parent.sessionId` (a raw Anthropic UUID), which the stream
    // renderer's parentId resolver can't match to a lane entry. The forked
    // subagent then orphans to root the moment its Done block commits — the
    // "subagent escapes the skill node" visual bug. The fix threads call.id
    // through SkillExecutionContext.callId so handlers can forward it as
    // `parentId: ctx.callId` on every forkSubagent call.
    const handler = vi.fn().mockResolvedValue('ok');
    registerSkill({ name: 'callid-skill', description: 'test', handler });

    const executor = new SkillExecutor({
      parentSession: {
        sessionId: 'parent-session',
        getInputStreamRef: () => ({ pushUserMessage: () => {} }),
        abortSignal,
      },
    });

    await executor.execute(makeCall({ name: 'callid-skill' }));

    expect(handler).toHaveBeenCalledWith(
      undefined,
      expect.anything(),
      expect.objectContaining({ callId: 'test-call' }),
    );
  });

  it('should return error for unknown skill with available list', async () => {
    registerSkill({
      name: 'known-skill',
      description: 'A known skill',
      handler: vi.fn().mockResolvedValue('ok'),
    });

    const executor = new SkillExecutor({
      parentSession: {
        sessionId: 'test',
        getInputStreamRef: () => ({ pushUserMessage: () => {} }),
        abortSignal,
      },
    });

    const result = await executor.execute(makeCall({ name: 'nonexistent' }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
    expect(result.content).toContain('known-skill');
  });

  it('should return error for missing name field', async () => {
    const executor = new SkillExecutor({
      parentSession: {
        sessionId: 'test',
        getInputStreamRef: () => ({ pushUserMessage: () => {} }),
        abortSignal,
      },
    });

    const result = await executor.execute(makeCall({ arguments: 'no name' }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('name');
  });

  it('should return error for non-object input', async () => {
    const executor = new SkillExecutor({
      parentSession: {
        sessionId: 'test',
        getInputStreamRef: () => ({ pushUserMessage: () => {} }),
        abortSignal,
      },
    });

    const result = await executor.execute(makeCall('not-an-object'));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('must be an object');
  });

  it('should handle skill handler throwing', async () => {
    registerSkill({
      name: 'throwing-skill',
      description: 'test',
      handler: vi.fn().mockRejectedValue(new Error('skill boom')),
    });

    const executor = new SkillExecutor({
      parentSession: {
        sessionId: 'test',
        getInputStreamRef: () => ({ pushUserMessage: () => {} }),
        abortSignal,
      },
    });

    const result = await executor.execute(makeCall({ name: 'throwing-skill' }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('skill boom');
  });

  it('regression: trusted skill complete event fires even when handler throws (HIGH fix)', async () => {
    // Register the skill as trusted in the agent-layer registry.
    registerTrustedSkillName('trusted-throwing');
    registerSkill({
      name: 'trusted-throwing',
      description: 'test',
      handler: vi.fn().mockRejectedValue(new Error('trusted boom')),
    });

    const completedResults: TrustedSkillResult[] = [];
    const listener = (r: TrustedSkillResult) => completedResults.push(r);
    onTrustedSkillComplete(listener);

    const executor = new SkillExecutor({
      parentSession: {
        sessionId: 'test',
        getInputStreamRef: () => ({ pushUserMessage: () => {} }),
        abortSignal,
      },
    });

    try {
      const result = await executor.execute(makeCall({ name: 'trusted-throwing' }));
      // The executor swallows the error and returns an error ToolResult.
      expect(result.isError).toBe(true);
      expect(result.content).toContain('trusted boom');
    } finally {
      offTrustedSkillComplete(listener);
    }

    // Complete event must have fired despite the handler throwing.
    expect(completedResults).toHaveLength(1);
    expect(completedResults[0]!.skillName).toBe('trusted-throwing');
    expect(completedResults[0]!.isError).toBe(true);
    expect(completedResults[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should return abort for already-aborted signal', async () => {
    const aborted = AbortSignal.abort();
    const executor = new SkillExecutor({
      parentSession: {
        sessionId: 'test',
        getInputStreamRef: () => ({ pushUserMessage: () => {} }),
        abortSignal,
      },
    });

    const result = await executor.execute({
      id: 'test',
      name: 'skill',
      input: { name: 'any' },
      signal: aborted,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('aborted');
  });

  describe('depth gating', () => {
    it('should allow skills when depth < maxDepth', async () => {
      registerSkill({
        name: 'shallow-skill',
        description: 'test',
        handler: vi.fn().mockResolvedValue('ok'),
      });

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'test',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
        depth: 1,
        maxDepth: 3,
      });

      const result = await executor.execute(makeCall({ name: 'shallow-skill' }));
      expect(result.isError).toBeUndefined();
      expect(result.content).toBe('ok');
    });

    it('should block skills when depth >= maxDepth', async () => {
      registerSkill({
        name: 'blocked-skill',
        description: 'test',
        handler: vi.fn().mockResolvedValue('should not run'),
      });

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'test',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
        depth: 3,
        maxDepth: 3,
      });

      const result = await executor.execute(makeCall({ name: 'blocked-skill' }));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('nesting depth');
      expect(result.content).toContain('3');
    });

    it('should use DEFAULT_MAX_NESTING_DEPTH when maxDepth not specified', async () => {
      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'test',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
        depth: 3,
      });

      const result = await executor.execute(makeCall({ name: 'any-skill' }));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('nesting depth');
    });

    it('should allow skills at root depth (no depth specified)', async () => {
      registerSkill({
        name: 'root-skill',
        description: 'test',
        handler: vi.fn().mockResolvedValue('root ok'),
      });

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'test',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
      });

      const result = await executor.execute(makeCall({ name: 'root-skill' }));
      expect(result.isError).toBeUndefined();
      expect(result.content).toBe('root ok');
    });
  });

  it('should stringify non-string handler results', async () => {
    registerSkill({
      name: 'json-skill',
      description: 'test',
      handler: vi.fn().mockResolvedValue({ key: 'value', count: 42 }),
    });

    const executor = new SkillExecutor({
      parentSession: {
        sessionId: 'test',
        getInputStreamRef: () => ({ pushUserMessage: () => {} }),
        abortSignal,
      },
    });

    const result = await executor.execute(makeCall({ name: 'json-skill' }));
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toEqual({ key: 'value', count: 42 });
  });

  describe('fork context', () => {
    it('should fork a subagent for skill with context: fork', async () => {
      const mockHandler = vi.fn();
      registerSkill({
        name: 'fork-skill',
        description: 'test',
        context: 'fork',
        handler: mockHandler,
      });

      vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({
        'system.md': 'fake-system-prompt',
      });

      const mockForkSubagent = vi.fn().mockResolvedValue({
        runToResult: vi.fn().mockResolvedValue({
          status: 'succeeded',
          message: { content: 'forked-result-text' },
        }),
        teardown: vi.fn().mockResolvedValue(undefined),
      });

      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockImplementation(
        mockForkSubagent,
      );
      vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'parent-123',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
        defaultModel: 'sonnet',
      });

      const result = await executor.execute(makeCall({ name: 'fork-skill', arguments: 'test args' }));

      expect(result.isError).toBeUndefined();
      expect(result.content).toBe('forked-result-text');
      expect(mockForkSubagent).toHaveBeenCalledOnce();
      expect(mockForkSubagent).toHaveBeenCalledWith(
        expect.objectContaining({
          parent: expect.objectContaining({ sessionId: 'parent-123' }),
          config: expect.objectContaining({
            model: 'sonnet',
            systemPrompt: 'fake-system-prompt',
          }),
          idPrefix: 'skill-fork-fork-skill',
          parentId: 'test-call',
          agentType: 'fork-skill',
        }),
      );
      // Handler should not be called for forked skills
      expect(mockHandler).not.toHaveBeenCalled();
    });

    it('should use skill.model override when forking', async () => {
      registerSkill({
        name: 'fork-skill-override',
        description: 'test',
        context: 'fork',
        model: 'opus',
        handler: vi.fn(),
      });

      vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({
        'system.md': 'fake-system-prompt',
      });

      const mockForkSubagent = vi.fn().mockResolvedValue({
        runToResult: vi.fn().mockResolvedValue({
          status: 'succeeded',
          message: { content: 'result' },
        }),
        teardown: vi.fn().mockResolvedValue(undefined),
      });

      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockImplementation(
        mockForkSubagent,
      );
      vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'parent-123',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
        defaultModel: 'sonnet',
      });

      await executor.execute(makeCall({ name: 'fork-skill-override' }));

      expect(mockForkSubagent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            model: 'opus',
          }),
        }),
      );
    });

    it('should prefer defaultSubagentModel over defaultModel when forking', async () => {
      registerSkill({
        name: 'fork-skill-env-default',
        description: 'test',
        context: 'fork',
        handler: vi.fn(),
      });

      vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({
        'system.md': 'fake-system-prompt',
      });

      const mockForkSubagent = vi.fn().mockResolvedValue({
        runToResult: vi.fn().mockResolvedValue({
          status: 'succeeded',
          message: { content: 'result' },
        }),
        teardown: vi.fn().mockResolvedValue(undefined),
      });

      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockImplementation(
        mockForkSubagent,
      );
      vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'parent-123',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
        defaultModel: 'opus',
        defaultSubagentModel: 'haiku',
      });

      await executor.execute(makeCall({ name: 'fork-skill-env-default' }));

      expect(mockForkSubagent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ model: 'haiku' }),
        }),
      );
    });

    it('should not fork for skill with context: inline', async () => {
      const handler = vi.fn().mockResolvedValue('inline-result');
      registerSkill({
        name: 'inline-skill',
        description: 'test',
        context: 'inline',
        handler,
      });

      const mockForkSubagent = vi.fn();
      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockImplementation(
        mockForkSubagent,
      );

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'test',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
      });

      const result = await executor.execute(makeCall({ name: 'inline-skill' }));

      expect(result.content).toBe('inline-result');
      expect(handler).toHaveBeenCalledOnce();
      expect(mockForkSubagent).not.toHaveBeenCalled();
    });

    it('should not fork for skill with undefined context (default to inline)', async () => {
      const handler = vi.fn().mockResolvedValue('default-inline-result');
      registerSkill({
        name: 'default-skill',
        description: 'test',
        handler,
      });

      const mockForkSubagent = vi.fn();
      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockImplementation(
        mockForkSubagent,
      );

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'test',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
      });

      const result = await executor.execute(makeCall({ name: 'default-skill' }));

      expect(result.content).toBe('default-inline-result');
      expect(handler).toHaveBeenCalledOnce();
      expect(mockForkSubagent).not.toHaveBeenCalled();
    });

    it('should return error when fork skill has no system.md', async () => {
      registerSkill({
        name: 'fork-no-prompt',
        description: 'test',
        context: 'fork',
        handler: vi.fn(),
      });

      vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({
        'other.md': 'not-system',
      });

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'test',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
      });

      const result = await executor.execute(makeCall({ name: 'fork-no-prompt' }));

      expect(result.isError).toBe(true);
      expect(result.content).toContain('fork-no-prompt');
      expect(result.content).toContain('prompts/system.md');
    });

    it('should handle fork subagent failure gracefully', async () => {
      registerSkill({
        name: 'fork-fail',
        description: 'test',
        context: 'fork',
        handler: vi.fn(),
      });

      vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({
        'system.md': 'fake-system-prompt',
      });

      const mockForkSubagent = vi.fn().mockResolvedValue({
        runToResult: vi.fn().mockResolvedValue({
          status: 'failed',
          error: { message: 'subagent error' },
        }),
        teardown: vi.fn().mockResolvedValue(undefined),
      });

      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockImplementation(
        mockForkSubagent,
      );
      vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'test',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
      });

      const result = await executor.execute(makeCall({ name: 'fork-fail' }));

      expect(result.isError).toBe(true);
      expect(result.content).toContain('subagent error');
    });

    it('should handle fork exception during forkSubagent call', async () => {
      registerSkill({
        name: 'fork-exception',
        description: 'test',
        context: 'fork',
        handler: vi.fn(),
      });

      vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({
        'system.md': 'fake-system-prompt',
      });

      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockRejectedValue(
        new Error('fork boom'),
      );
      vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'test',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
      });

      const result = await executor.execute(makeCall({ name: 'fork-exception' }));

      expect(result.isError).toBe(true);
      expect(result.content).toContain('fork boom');
    });

    it('cancelled forked registry skill with partial output surfaces partial output and marker (not isError)', async () => {
      registerSkill({
        name: 'fork-cancelled-partial',
        description: 'test',
        context: 'fork',
        handler: vi.fn(),
      });

      vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({
        'system.md': 'fake-system-prompt',
      });

      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockResolvedValue({
        runToResult: vi.fn().mockResolvedValue({
          status: 'cancelled',
          partialOutput: 'I had analyzed 3 of 10 files when cancelled',
        }),
        teardown: vi.fn().mockResolvedValue(undefined),
      } as never);
      vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'test',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
      });

      const result = await executor.execute(makeCall({ name: 'fork-cancelled-partial' }));

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('[skill cancelled mid-flight — partial output preserved below]');
      expect(result.content).toContain('I had analyzed 3 of 10 files when cancelled');
    });

    it('cancelled forked registry skill with NO partial output returns isError=true (regression guard)', async () => {
      registerSkill({
        name: 'fork-cancelled-no-partial',
        description: 'test',
        context: 'fork',
        handler: vi.fn(),
      });

      vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({
        'system.md': 'fake-system-prompt',
      });

      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockResolvedValue({
        runToResult: vi.fn().mockResolvedValue({
          status: 'cancelled',
          error: { message: 'skill was cancelled' },
        }),
        teardown: vi.fn().mockResolvedValue(undefined),
      } as never);
      vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'test',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
      });

      const result = await executor.execute(makeCall({ name: 'fork-cancelled-no-partial' }));

      expect(result.isError).toBe(true);
      expect(result.content).toContain('skill was cancelled');
    });

    it('should pass empty string as user message when no arguments provided', async () => {
      registerSkill({
        name: 'fork-no-args',
        description: 'test',
        context: 'fork',
        handler: vi.fn(),
      });

      vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({
        'system.md': 'fake-system-prompt',
      });

      const mockRunToResult = vi.fn().mockResolvedValue({
        status: 'succeeded',
        message: { content: 'result' },
      });

      const mockForkSubagent = vi.fn().mockResolvedValue({
        runToResult: mockRunToResult,
        teardown: vi.fn().mockResolvedValue(undefined),
      });

      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockImplementation(
        mockForkSubagent,
      );
      vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'test',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
      });

      await executor.execute(makeCall({ name: 'fork-no-args' }));

      expect(mockRunToResult).toHaveBeenCalledWith('Run the fork-no-args skill now, following the instructions in your system prompt.');
    });

    it('should pass arguments as user message when provided', async () => {
      registerSkill({
        name: 'fork-with-args',
        description: 'test',
        context: 'fork',
        handler: vi.fn(),
      });

      vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({
        'system.md': 'fake-system-prompt',
      });

      const mockRunToResult = vi.fn().mockResolvedValue({
        status: 'succeeded',
        message: { content: 'result' },
      });

      const mockForkSubagent = vi.fn().mockResolvedValue({
        runToResult: mockRunToResult,
        teardown: vi.fn().mockResolvedValue(undefined),
      });

      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockImplementation(
        mockForkSubagent,
      );
      vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'test',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
      });

      await executor.execute(makeCall({ name: 'fork-with-args', arguments: 'my custom args' }));

      expect(mockRunToResult).toHaveBeenCalledWith('my custom args');
    });

    // Worktree-cwd propagation through the `skill` tool dispatch path.
    //
    // External constraint: skills invoked via the `skill` tool — `/diagnose`,
    // `/mint`, `/gather`, etc. — spawn their internal subagents through a
    // per-call SubagentManager constructed inside the executor (see
    // skill-executor.ts:executeForkedRegistrySkill / executePluginSkill).
    // Before this fix, that manager was instantiated with no `cwd` —
    // `parentCwd` undefined — so SubagentManager.forkSubagent silently
    // omitted `cwd` from the child config. The child's bash/grep/read_file
    // then resolved against `process.cwd()` (host repo), defeating
    // `afk --worktree` isolation for the entire skill dispatch tree.
    //
    // This test pins the fix by capturing the manager instance via
    // forkSubagent's `this` binding and asserting `parentCwd` matches the
    // configured worktree cwd.
    it('forwards ctx.cwd to the per-call SubagentManager (worktree isolation for skill subagents)', async () => {
      registerSkill({
        name: 'fork-skill-cwd',
        description: 'test',
        context: 'fork',
        handler: vi.fn(),
      });

      vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({
        'system.md': 'fake-system-prompt',
      });

      let capturedManager: SubagentManager | undefined;
      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockImplementation(
        function (this: SubagentManager) {
          capturedManager = this;
          return Promise.resolve({
            id: 'h',
            runToResult: vi.fn().mockResolvedValue({
              status: 'succeeded',
              message: { content: 'ok' },
            }),
            teardown: vi.fn().mockResolvedValue(undefined),
          }) as any;
        } as any,
      );
      vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'parent-123',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
        defaultModel: 'sonnet',
        cwd: '/tmp/wt/feat-x',
      });

      const result = await executor.execute(makeCall({ name: 'fork-skill-cwd' }));

      expect(result.isError).toBeUndefined();
      expect(capturedManager).toBeDefined();
      // The per-call manager constructed inside executeForkedRegistrySkill
      // must carry cwd so its forkSubagent injects cwd into the skill
      // subagent's config (subagent.ts:291-297). Without this, the skill
      // subagent's bash/grep/read_file fall back to process.cwd().
      expect((capturedManager as unknown as { parentCwd: string | undefined }).parentCwd)
        .toBe('/tmp/wt/feat-x');
    });

    // setCwd re-anchors mid-session: a born-named `afk -w` worktree is created
    // on turn 1, after the SkillExecutor was constructed in the launch dir.
    // Without re-anchoring, skill subagents keep resolving against the launch
    // dir (host repo).
    it('setCwd re-anchors the per-call SubagentManager for skill subagents', async () => {
      registerSkill({
        name: 'fork-skill-setcwd',
        description: 'test',
        context: 'fork',
        handler: vi.fn(),
      });

      vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({
        'system.md': 'fake-system-prompt',
      });

      let capturedManager: SubagentManager | undefined;
      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockImplementation(
        function (this: SubagentManager) {
          capturedManager = this;
          return Promise.resolve({
            id: 'h',
            runToResult: vi.fn().mockResolvedValue({
              status: 'succeeded',
              message: { content: 'ok' },
            }),
            teardown: vi.fn().mockResolvedValue(undefined),
          }) as any;
        } as any,
      );
      vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'parent-123',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
        defaultModel: 'sonnet',
        cwd: '/tmp/launch/dir',
      });

      executor.setCwd('/tmp/launch/dir/.afk-worktrees/afk-xyz');

      const result = await executor.execute(makeCall({ name: 'fork-skill-setcwd' }));

      expect(result.isError).toBeUndefined();
      expect((capturedManager as unknown as { parentCwd: string | undefined }).parentCwd)
        .toBe('/tmp/launch/dir/.afk-worktrees/afk-xyz');
    });
  });

  describe('resolveApiKeyForModel — per-model credential resolution (skill fork path)', () => {
    // Regression: "Anthropic child starves when parent is OpenAI-routed."
    // Same root cause as subagent-executor.test.ts's block — the skill-dispatch
    // fork is the *other* path that starved. The skill child's credential
    // flows to `new SubagentManager({ apiKey })` (stored as parentApiKey,
    // subagent.ts:204/216) and is used at forkSubagent (subagent.ts:347:
    // `options.config.apiKey || this.parentApiKey`). We capture the per-call
    // manager via forkSubagent's `this` binding and assert parentApiKey —
    // mirrors the `parentCwd` worktree-isolation test above.

    function captureManagerOnFork(): { get: () => SubagentManager | undefined } {
      let captured: SubagentManager | undefined;
      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockImplementation(
        function (this: SubagentManager) {
          captured = this;
          return Promise.resolve({
            id: 'h',
            runToResult: vi.fn().mockResolvedValue({
              status: 'succeeded',
              message: { content: 'ok' },
            }),
            teardown: vi.fn().mockResolvedValue(undefined),
          }) as any;
        } as any,
      );
      vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);
      return { get: () => captured };
    }

    it('resolves the skill child apiKey by the child model via the injected resolver', async () => {
      registerSkill({ name: 'fork-skill-cred', description: 'test', context: 'fork', handler: vi.fn() });
      vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({ 'system.md': 'fake-system-prompt' });
      const capture = captureManagerOnFork();

      // Parent is OpenAI-routed (ctx.apiKey is the OpenAI cred). The skill
      // child defaults to 'sonnet' (Anthropic) and must get the Anthropic
      // credential from the resolver, not ctx.apiKey.
      const resolveApiKeyForModel = vi.fn((model: string) =>
        model === 'sonnet' ? 'anthropic-keychain-token' : 'openai-key',
      );

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'parent-123',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
        defaultModel: 'sonnet',
        apiKey: 'openai-key',
        resolveApiKeyForModel,
      });

      const result = await executor.execute(makeCall({ name: 'fork-skill-cred' }));

      expect(result.isError).toBeUndefined();
      expect(resolveApiKeyForModel).toHaveBeenCalledWith('sonnet');
      expect((capture.get() as unknown as { parentApiKey: string | undefined }).parentApiKey)
        .toBe('anthropic-keychain-token');
    });

    it('calls resolveCredentialForModel directly when no resolver is injected', async () => {
      // New behavior (refactor/relocate-credential-resolver): when no
      // resolveApiKeyForModel is injected, the executor calls
      // resolveCredentialForModel from the agent layer directly — rather than
      // falling back to ctx.apiKey. The mock returns 'resolved-test-credential'.
      registerSkill({ name: 'fork-skill-legacy', description: 'test', context: 'fork', handler: vi.fn() });
      vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({ 'system.md': 'fake-system-prompt' });
      const capture = captureManagerOnFork();

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'parent-123',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
        defaultModel: 'sonnet',
        apiKey: 'parent-key',
      });

      await executor.execute(makeCall({ name: 'fork-skill-legacy' }));

      expect(mockResolveCredentialForModel).toHaveBeenCalledWith('sonnet');
      expect((capture.get() as unknown as { parentApiKey: string | undefined }).parentApiKey)
        .toBe('resolved-test-credential');
    });
  });

  describe('handle teardown — trace sealing', () => {
    // Regression: SkillExecutor's `finally` block must call
    // `handle.teardown()` for every fork. Without it, the child
    // AgentSession's `session.close()` is never invoked, which means
    // `dispatchSessionEndOnce()` doesn't run, which means neither the
    // `closure` event nor the `session_sealed` event is written to the
    // child's witness trace. Downstream impact: `closure-anomaly` and
    // any future detector keyed off terminal events is blinded to most
    // sessions.
    //
    // `manager.teardownAll()` is NOT sufficient — by the time `finally`
    // executes, a successfully-completed handle has already self-removed
    // from `manager.active` via the `onTerminal` closure
    // (subagent.ts:340-343). The fix is documented at subagent.ts:412-414.
    //
    // Mirrors `subagent-executor.test.ts:542-574` — keep these two test
    // blocks in symmetry. If you change one, change the other.

    function setupForkedRegistrySkill(skillName: string, runResult: unknown) {
      registerSkill({
        name: skillName,
        description: 'test',
        context: 'fork',
        handler: vi.fn(),
      });
      vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({
        'system.md': 'fake-system-prompt',
      });
      const teardown = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockResolvedValue({
        runToResult: vi.fn().mockResolvedValue(runResult),
        teardown,
      } as never);
      vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);
      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'parent-tx',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
      });
      return { executor, teardown };
    }

    it('forked registry skill: teardown called on succeeded result', async () => {
      const { executor, teardown } = setupForkedRegistrySkill('teardown-ok', {
        status: 'succeeded',
        message: { content: 'ok' },
      });
      await executor.execute(makeCall({ name: 'teardown-ok' }));
      expect(teardown).toHaveBeenCalledTimes(1);
    });

    it('forked registry skill: teardown called on failed result', async () => {
      const { executor, teardown } = setupForkedRegistrySkill('teardown-fail', {
        status: 'failed',
        error: { message: 'subagent boom' },
      });
      await executor.execute(makeCall({ name: 'teardown-fail' }));
      expect(teardown).toHaveBeenCalledTimes(1);
    });

    it('forked registry skill: teardown called on cancelled-with-partial result', async () => {
      const { executor, teardown } = setupForkedRegistrySkill('teardown-cancel', {
        status: 'cancelled',
        partialOutput: 'partial work',
      });
      await executor.execute(makeCall({ name: 'teardown-cancel' }));
      expect(teardown).toHaveBeenCalledTimes(1);
    });

    it('forked registry skill: teardown called when runToResult throws', async () => {
      registerSkill({
        name: 'teardown-throw',
        description: 'test',
        context: 'fork',
        handler: vi.fn(),
      });
      vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({
        'system.md': 'fake-system-prompt',
      });
      const teardown = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockResolvedValue({
        runToResult: vi.fn().mockRejectedValue(new Error('runtime boom')),
        teardown,
      } as never);
      vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'parent-tx',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
      });
      const result = await executor.execute(makeCall({ name: 'teardown-throw' }));
      expect(result.isError).toBe(true);
      expect(teardown).toHaveBeenCalledTimes(1);
    });

    it('forked registry skill: finally block survives forkSubagent itself throwing', async () => {
      // Regression for the `| undefined` guard added to skill-executor.ts.
      // If forkSubagent throws (e.g. `new AgentSession()` constructor error,
      // per subagent.ts:316-320), `handle` is still undefined when finally
      // runs. The guard prevents a TypeError that would mask the real cause.
      registerSkill({
        name: 'fork-throw-guard',
        description: 'test',
        context: 'fork',
        handler: vi.fn(),
      });
      vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({
        'system.md': 'fake-system-prompt',
      });
      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockRejectedValue(
        new Error('fork-construction boom'),
      );
      vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'parent-tx',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
      });
      const result = await executor.execute(makeCall({ name: 'fork-throw-guard' }));
      // The real error message must reach the caller — NOT a
      // "Cannot read properties of undefined (reading 'teardown')" mask.
      expect(result.isError).toBe(true);
      expect(result.content).toContain('fork-construction boom');
    });

    function setupPluginSkill(skillName: string, runResult: unknown) {
      const teardown = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockResolvedValue({
        runToResult: vi.fn().mockResolvedValue(runResult),
        teardown,
      } as never);
      vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);
      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'parent-tx',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
      });
      (executor as unknown as { pluginBodies: Map<string, PluginSkillBody> | null }).pluginBodies =
        new Map([[skillName, { body: 'plugin body text', pluginPath: '/fake/plugin', context: 'fork' }]]);
      return { executor, teardown };
    }

    it('plugin skill: teardown called on succeeded result', async () => {
      const { executor, teardown } = setupPluginSkill('plugin-ok', {
        status: 'succeeded',
        message: { content: 'ok' },
      });
      await executor.execute(makeCall({ name: 'plugin-ok' }));
      expect(teardown).toHaveBeenCalledTimes(1);
    });

    it('plugin skill: teardown called on failed result', async () => {
      const { executor, teardown } = setupPluginSkill('plugin-fail', {
        status: 'failed',
        error: { message: 'plugin boom' },
      });
      await executor.execute(makeCall({ name: 'plugin-fail' }));
      expect(teardown).toHaveBeenCalledTimes(1);
    });

    it('plugin skill: teardown called when runToResult throws', async () => {
      const teardown = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockResolvedValue({
        runToResult: vi.fn().mockRejectedValue(new Error('plugin runtime boom')),
        teardown,
      } as never);
      vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'parent-tx',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
      });
      (executor as unknown as { pluginBodies: Map<string, PluginSkillBody> | null }).pluginBodies =
        new Map([['plugin-throw', { body: 'plugin body', pluginPath: '/fake/plugin', context: 'fork' }]]);

      const result = await executor.execute(makeCall({ name: 'plugin-throw' }));
      expect(result.isError).toBe(true);
      expect(teardown).toHaveBeenCalledTimes(1);
    });
  });

  describe('renderer-nesting contract (parentId + agentType)', () => {
    // Pins the contract between SkillExecutor and StreamRenderer.process()'s
    // 3-way parentId resolver. Mirrors ComposeExecutor (compose-executor.ts:
    // 220-232). Without `parentId: call.id`, the synthesized `Agent(<label>)`
    // entry resolves to path 3 (unresolved) and renders at root — sibling to
    // the `◆ skill` entry, not nested under it. The visible symptom is
    // "nothing under the skill row" even when the child IS emitting events.
    //
    // If this test fails, do NOT just update the assertion — the renderer
    // nesting depends on this contract, and silently breaking it ships a
    // regression with no other test failures.

    it('plugin-skill fork passes parentId=call.id and agentType=skillName to forkSubagent', async () => {
      // Plugin path is the one users hit with `/research`, `/forge`, etc.
      // when those live in ~/.afk/plugins/. We populate the executor's
      // private `pluginBodies` cache directly so we don't need to spin up a
      // fake plugin manifest just to exercise the fork plumbing — the
      // discovery layer is tested elsewhere; what we care about here is
      // that `executePluginSkill` threads parentId/agentType through.

      const mockForkSubagent = vi.fn().mockResolvedValue({
        runToResult: vi.fn().mockResolvedValue({
          status: 'succeeded',
          message: { content: 'plugin-result' },
        }),
        teardown: vi.fn().mockResolvedValue(undefined),
      });
      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockImplementation(mockForkSubagent);
      vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'parent-456',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
        defaultModel: 'sonnet',
      });

      // Pre-populate the cache so `getPluginSkillBody` returns a body for
      // our synthetic name without invoking `discoverPluginSkillBodies`.
      (executor as unknown as { pluginBodies: Map<string, PluginSkillBody> | null }).pluginBodies =
        new Map([['nest-pin-plugin', { body: 'plugin-body-text', pluginPath: '/fake/plugin', context: 'fork' }]]);

      await executor.execute(makeCall({ name: 'nest-pin-plugin' }));

      expect(mockForkSubagent).toHaveBeenCalledOnce();
      expect(mockForkSubagent).toHaveBeenCalledWith(
        expect.objectContaining({
          // Load-bearing: tool_use_id of THIS skill call, not the parent
          // session UUID. StreamRenderer's path 2 fires on this value.
          parentId: 'test-call',
          // Renderer label for the synthetic Agent(<label>) entry.
          agentType: 'nest-pin-plugin',
          idPrefix: 'skill-nest-pin-plugin',
        }),
      );
    });
  });

  /**
   * Regression coverage for the nested-dispatch wiring fix.
   *
   * Before this fix, `executePluginSkill` and `executeForkedRegistrySkill`
   * forked their child with `config: { model, systemPrompt }` only — no
   * `provider` override. The child fell back to the bare
   * `AnthropicDirectProvider` singleton, whose tool schema omits `agent`
   * and `skill` (anthropic-direct/index.ts: schemas only include those
   * tools when `opts.subagentExecutor`/`opts.skillExecutor` are present).
   * Skill children silently lost the ability to fan out, and any SKILL.md
   * that instructed the model to "dispatch sub-agents via the Agent tool"
   * (e.g. the example-plugin `/ceiling-test` skill's 20-parallel hypothesis
   * wave) became un-executable as written — the model fell back to inline
   * Write/Bash work, defeating the orchestration premise.
   *
   * These tests assert that when SkillExecutor is constructed WITH the
   * factories, the forked child config carries a `provider` value so the
   * child's tool schema is wired for nested dispatch, and that when the
   * factories are absent (or the depth ceiling is hit), the child config
   * omits `provider` and the child falls back gracefully.
   */
  describe('nested dispatch wiring (childProviderFactory)', () => {
    function captureForkConfig(): { mockForkSubagent: ReturnType<typeof vi.fn> } {
      const mockForkSubagent = vi.fn().mockResolvedValue({
        runToResult: vi.fn().mockResolvedValue({
          status: 'succeeded',
          message: { content: 'ok' },
        }),
        teardown: vi.fn().mockResolvedValue(undefined),
      });
      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockImplementation(
        mockForkSubagent,
      );
      vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);
      return { mockForkSubagent };
    }

    it('forwards childProviderFactory into the plugin-skill child config', async () => {
      const { mockForkSubagent } = captureForkConfig();
      const sentinelProvider = { name: 'sentinel-child-provider' } as unknown;
      const childProviderFactory = vi.fn().mockReturnValue(sentinelProvider);

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'p',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
        pluginConfigs: undefined,
        childProviderFactory: childProviderFactory as never,
      });

      // Stub the plugin body lookup so executePluginSkill is reached.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (executor as any).pluginBodies = new Map([['nested', { body: 'fake plugin body', pluginPath: '/fake/plugin', context: 'fork' }]]);

      await executor.execute(makeCall({ name: 'nested', arguments: 'go' }));

      expect(childProviderFactory).toHaveBeenCalledOnce();
      // The forked child config should carry the factory's return value as
      // `provider`. Without this, the child's `AnthropicDirectProvider`
      // would lack the `agent`/`skill` tools.
      expect(mockForkSubagent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ provider: sentinelProvider }),
          idPrefix: 'skill-nested',
        }),
      );
    });

    it('forwards childProviderFactory into the forked-registry-skill child config', async () => {
      const { mockForkSubagent } = captureForkConfig();
      vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({
        'system.md': 'fake prompt',
      });
      registerSkill({
        name: 'forked-with-factory',
        description: 'test',
        context: 'fork',
        handler: vi.fn(),
      });

      const sentinelProvider = { name: 'sentinel' } as unknown;
      const childProviderFactory = vi.fn().mockReturnValue(sentinelProvider);

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'p',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
        defaultModel: 'sonnet',
        childProviderFactory: childProviderFactory as never,
      });

      await executor.execute(makeCall({ name: 'forked-with-factory' }));

      expect(childProviderFactory).toHaveBeenCalledOnce();
      expect(mockForkSubagent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ provider: sentinelProvider }),
        }),
      );
    });

    it('omits provider when no childProviderFactory is configured (back-compat)', async () => {
      const { mockForkSubagent } = captureForkConfig();

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'p',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (executor as any).pluginBodies = new Map([['no-factory', { body: 'body', pluginPath: '/fake/plugin', context: 'fork' }]]);

      await executor.execute(makeCall({ name: 'no-factory' }));

      const forkCall = mockForkSubagent.mock.calls[0]?.[0];
      expect(forkCall?.config?.provider).toBeUndefined();
    });

    it('omits provider when depth has reached maxDepth (graceful degradation)', async () => {
      const { mockForkSubagent } = captureForkConfig();
      const childProviderFactory = vi.fn().mockReturnValue({ name: 'should-not-be-used' });

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'p',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
        childProviderFactory: childProviderFactory as never,
        depth: 3,
        maxDepth: 3,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (executor as any).pluginBodies = new Map([['deep', { body: 'body', pluginPath: '/fake/plugin', context: 'fork' }]]);

      await executor.execute(makeCall({ name: 'deep' }));

      // Factory should NOT fire at the depth ceiling — child loses nesting
      // tools rather than recursing past maxDepth.
      expect(childProviderFactory).not.toHaveBeenCalled();
      const forkCall = mockForkSubagent.mock.calls[0]?.[0];
      expect(forkCall?.config?.provider).toBeUndefined();
    });

    it('propagates baseUrl into the SubagentExecutor defaultConfig for grandchild sessions (depth ≥ 1)', async () => {
      // Regression test for: buildForkedChildConfig dropped baseUrl from the
      // SubagentExecutor defaultConfig, causing grandchild sessions (depth ≥ 1
      // agent-tool dispatches from inside a forked skill) to silently revert to
      // api.anthropic.com instead of hitting the local shim.
      captureForkConfig();
      vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({
        'system.md': 'fake prompt',
      });
      registerSkill({
        name: 'baseurl-propagation-skill',
        description: 'test',
        context: 'fork',
        handler: vi.fn(),
      });

      const capturedCtorArgs: ConstructorParameters<typeof SubagentExecutorModule.SubagentExecutor>[] = [];
      const OriginalSubagentExecutor = SubagentExecutorModule.SubagentExecutor;
      vi.spyOn(SubagentExecutorModule, 'SubagentExecutor').mockImplementation(
        (...args: ConstructorParameters<typeof SubagentExecutorModule.SubagentExecutor>) => {
          capturedCtorArgs.push(args);
          return new OriginalSubagentExecutor(...args);
        },
      );

      const LOCAL_BASE_URL = 'http://127.0.0.1:11434';
      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'p',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
        defaultModel: 'sonnet',
        baseUrl: LOCAL_BASE_URL,
        childProviderFactory: vi.fn().mockReturnValue({ name: 'sentinel' }) as never,
      });

      await executor.execute(makeCall({ name: 'baseurl-propagation-skill' }));

      // The SubagentExecutor constructed inside buildForkedChildConfig must
      // carry baseUrl in its defaultConfig so grandchild agent-tool dispatches
      // hit the local shim, not api.anthropic.com.
      expect(capturedCtorArgs.length).toBeGreaterThan(0);
      const firstCtorCall = capturedCtorArgs[0];
      expect(firstCtorCall).toBeDefined();
      const ctorOpts = firstCtorCall?.[0];
      expect(ctorOpts?.defaultConfig).toMatchObject({ baseUrl: LOCAL_BASE_URL });
    });

    it('propagates backgroundRegistry into the SubagentExecutor for skill-forked subagents', async () => {
      // Regression test for: when a `/research`-style plugin skill's
      // subagent called `agent` with `mode:"background"` (the SKILL.md
      // "Dispatch N sub-agents in parallel" idiom), the SubagentExecutor
      // built inside SkillExecutor.buildForkedChildConfig was constructed
      // without a backgroundRegistry. That caused fast-fail with the
      // 163-byte "BackgroundAgentRegistry is not wired" error in ~24ms,
      // showing up in the tool-lane as `→ agent [subagent] ×2 — 2 errors`.
      //
      // The fix wires backgroundRegistry through SkillExecutorContext
      // → buildForkedChildConfig → SubagentExecutor.ctx.backgroundRegistry
      // so the registry travels root → skill-forked child → grandchild.
      captureForkConfig();
      vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({
        'system.md': 'fake prompt',
      });
      registerSkill({
        name: 'bg-registry-propagation-skill',
        description: 'test',
        context: 'fork',
        handler: vi.fn(),
      });

      const capturedCtorArgs: ConstructorParameters<typeof SubagentExecutorModule.SubagentExecutor>[] = [];
      const OriginalSubagentExecutor = SubagentExecutorModule.SubagentExecutor;
      vi.spyOn(SubagentExecutorModule, 'SubagentExecutor').mockImplementation(
        (...args: ConstructorParameters<typeof SubagentExecutorModule.SubagentExecutor>) => {
          capturedCtorArgs.push(args);
          return new OriginalSubagentExecutor(...args);
        },
      );

      // Sentinel registry — identity check is what proves wiring, not behavior.
      const sentinelRegistry = { __sentinel: 'bg-registry' } as never;

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'p',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
        defaultModel: 'sonnet',
        childProviderFactory: vi.fn().mockReturnValue({ name: 'sentinel' }) as never,
        backgroundRegistry: sentinelRegistry,
      });

      await executor.execute(makeCall({ name: 'bg-registry-propagation-skill' }));

      expect(capturedCtorArgs.length).toBeGreaterThan(0);
      const firstCtorCall = capturedCtorArgs[0];
      expect(firstCtorCall).toBeDefined();
      const ctorOpts = firstCtorCall?.[0];
      // Identity check: the child SubagentExecutor must receive the SAME
      // registry instance the host passed in. A different instance would
      // mean background jobs spawned inside the skill are invisible to
      // /bgsub:list / /bgsub:join on the parent REPL.
      expect(ctorOpts?.backgroundRegistry).toBe(sentinelRegistry);
    });

    it('omits backgroundRegistry from the SubagentExecutor when none is configured (back-compat)', async () => {
      // chat/threads/telegram surfaces deliberately do not wire a registry;
      // the optional spread in buildForkedChildConfig must omit the key
      // entirely so SubagentExecutorContext.backgroundRegistry stays
      // undefined and background-mode dispatches fast-fail with the
      // documented error rather than passing through a stale registry.
      captureForkConfig();
      vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({
        'system.md': 'fake prompt',
      });
      registerSkill({
        name: 'no-bg-registry-skill',
        description: 'test',
        context: 'fork',
        handler: vi.fn(),
      });

      const capturedCtorArgs: ConstructorParameters<typeof SubagentExecutorModule.SubagentExecutor>[] = [];
      const OriginalSubagentExecutor = SubagentExecutorModule.SubagentExecutor;
      vi.spyOn(SubagentExecutorModule, 'SubagentExecutor').mockImplementation(
        (...args: ConstructorParameters<typeof SubagentExecutorModule.SubagentExecutor>) => {
          capturedCtorArgs.push(args);
          return new OriginalSubagentExecutor(...args);
        },
      );

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'p',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
        defaultModel: 'sonnet',
        childProviderFactory: vi.fn().mockReturnValue({ name: 'sentinel' }) as never,
        // backgroundRegistry intentionally omitted
      });

      await executor.execute(makeCall({ name: 'no-bg-registry-skill' }));

      expect(capturedCtorArgs.length).toBeGreaterThan(0);
      const firstCtorCall = capturedCtorArgs[0];
      const ctorOpts = firstCtorCall?.[0];
      expect(ctorOpts?.backgroundRegistry).toBeUndefined();
    });
  });

  describe('read-only skill enforcement (RECON allowlist + readOnlyBash)', () => {
    function captureForkConfig(): { mockForkSubagent: ReturnType<typeof vi.fn> } {
      const mockForkSubagent = vi.fn().mockResolvedValue({
        runToResult: vi.fn().mockResolvedValue({
          status: 'succeeded',
          message: { content: 'ok' },
        }),
        teardown: vi.fn().mockResolvedValue(undefined),
      });
      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockImplementation(mockForkSubagent);
      vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);
      return { mockForkSubagent };
    }

    it('passes RECON_ALLOWED_TOOLS + readOnlyBash to the factory for a read-only registry skill', async () => {
      captureForkConfig();
      vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({ 'system.md': 'fake prompt' });
      registerSkill({
        name: 'recon-fork-skill',
        description: 'test',
        context: 'fork',
        readOnly: true,
        handler: vi.fn(),
      });
      const childProviderFactory = vi.fn().mockReturnValue({ name: 'sentinel' });

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'p',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
        defaultModel: 'sonnet',
        childProviderFactory: childProviderFactory as never,
      });

      await executor.execute(makeCall({ name: 'recon-fork-skill' }));

      expect(childProviderFactory).toHaveBeenCalledOnce();
      const factoryArgs = childProviderFactory.mock.calls[0]?.[0];
      expect(factoryArgs?.allowedTools).toEqual([...RECON_ALLOWED_TOOLS]);
      expect(factoryArgs?.readOnlyBash).toBe(true);
    });

    it('enforces read-only for ground-state by NAME even without the frontmatter flag', async () => {
      // ground-state is in DEFAULT_READ_ONLY_SKILLS, so a registry entry that
      // does NOT set readOnly still gets the recon allowlist + bash gate.
      captureForkConfig();
      vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({ 'system.md': 'fake prompt' });
      registerSkill({
        name: 'ground-state',
        description: 'test',
        context: 'fork',
        // readOnly intentionally omitted — name-keyed enforcement must still fire.
        handler: vi.fn(),
      });
      const childProviderFactory = vi.fn().mockReturnValue({ name: 'sentinel' });

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'p',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
        defaultModel: 'sonnet',
        childProviderFactory: childProviderFactory as never,
      });

      await executor.execute(makeCall({ name: 'ground-state' }));

      const factoryArgs = childProviderFactory.mock.calls[0]?.[0];
      expect(factoryArgs?.allowedTools).toEqual([...RECON_ALLOWED_TOOLS]);
      expect(factoryArgs?.readOnlyBash).toBe(true);
    });

    it('does NOT restrict a normal (read-write) skill', async () => {
      captureForkConfig();
      vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({ 'system.md': 'fake prompt' });
      registerSkill({
        name: 'normal-fork-skill',
        description: 'test',
        context: 'fork',
        handler: vi.fn(),
      });
      const childProviderFactory = vi.fn().mockReturnValue({ name: 'sentinel' });

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'p',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
        defaultModel: 'sonnet',
        childProviderFactory: childProviderFactory as never,
      });

      await executor.execute(makeCall({ name: 'normal-fork-skill' }));

      const factoryArgs = childProviderFactory.mock.calls[0]?.[0];
      // No allowlist override and no bash gate — the factory falls back to
      // CHILD_ALLOWED_TOOLS (full write surface).
      expect(factoryArgs?.allowedTools).toBeUndefined();
      expect(factoryArgs?.readOnlyBash).toBeUndefined();
    });

    it('passes RECON allowlist + readOnlyBash for a read-only PLUGIN skill', async () => {
      const { mockForkSubagent } = captureForkConfig();
      const childProviderFactory = vi.fn().mockReturnValue({ name: 'sentinel' });

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'p',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
        pluginConfigs: undefined,
        childProviderFactory: childProviderFactory as never,
      });

      // Stub a read-only plugin body so executePluginSkill is reached.
      const body: PluginSkillBody = {
        body: 'fake plugin body',
        pluginPath: '/fake/plugin',
        // context: 'fork' is required for the read-only enforcement path: since
        // the 2026-06 load-by-default flip, a plugin skill forks (and thus gets
        // the RECON allowlist) only when it explicitly declares context: fork.
        // The real bundled ground-state carries both read-only: true + context: fork.
        context: 'fork',
        readOnly: true,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (executor as any).pluginBodies = new Map([['recon-plugin', body]]);

      await executor.execute(makeCall({ name: 'recon-plugin', arguments: 'go' }));

      expect(mockForkSubagent).toHaveBeenCalledOnce();
      const factoryArgs = childProviderFactory.mock.calls[0]?.[0];
      expect(factoryArgs?.allowedTools).toEqual([...RECON_ALLOWED_TOOLS]);
      expect(factoryArgs?.readOnlyBash).toBe(true);
    });

    it('read-only + tools: intersection of tools list with RECON_ALLOWED_TOOLS, readOnlyBash still true', async () => {
      // B1 regression path: a plugin skill with BOTH read-only: true AND a
      // tools: allowlist must produce a child whose effective allowedTools is
      // the intersection of the tools list with RECON_ALLOWED_TOOLS, and
      // readOnlyBash must remain true.  Previously the post-fork
      // buildSkillRestrictedProvider override would drop readOnlyBash.
      captureForkConfig();
      const childProviderFactory = vi.fn().mockReturnValue({ name: 'sentinel' });

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'p',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
        pluginConfigs: undefined,
        childProviderFactory: childProviderFactory as never,
      });

      // tools: list includes both RECON-allowed and non-RECON (write_file)
      // tokens. The intersection must keep only the RECON-allowed ones.
      const body: PluginSkillBody = {
        body: 'fake plugin body',
        pluginPath: '/fake/plugin',
        // Since the 2026-06 load-by-default flip, a plugin skill forks (and thus
        // gets the tools/RECON allowlist) only when it declares context: fork.
        context: 'fork',
        readOnly: true,
        allowedTools: ['read_file', 'bash', 'write_file'],
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (executor as any).pluginBodies = new Map([['recon-tools-plugin', body]]);

      await executor.execute(makeCall({ name: 'recon-tools-plugin' }));

      const factoryArgs = childProviderFactory.mock.calls[0]?.[0];
      // Only RECON-allowed tokens survive the intersection.
      expect(factoryArgs?.allowedTools).toEqual(['read_file', 'bash']);
      // readOnlyBash must still be true — the bash gate is not dropped.
      expect(factoryArgs?.readOnlyBash).toBe(true);
    });

    it('with NO factory, a read-only skill still gets a recon provider (fallback path)', async () => {
      const { mockForkSubagent } = captureForkConfig();
      // No childProviderFactory configured → the no-factory branch of
      // buildForkedChildConfig runs. A read-only skill must still receive an
      // explicit read-only recon provider rather than the bare (full-write)
      // singleton. (depth defaults to 0 < maxDepth, so execute() proceeds to
      // the fork — this exercises the `!childProviderFactory` half of the
      // early-return condition.)
      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'p',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
        // childProviderFactory intentionally omitted.
      });

      const body: PluginSkillBody = {
        body: 'fake plugin body',
        pluginPath: '/fake/plugin',
        // context: 'fork' required — see the recon-plugin test above. Read-only
        // enforcement only applies on the fork path; a loaded skill has no child.
        context: 'fork',
        readOnly: true,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (executor as any).pluginBodies = new Map([['fallback-recon', body]]);

      await executor.execute(makeCall({ name: 'fallback-recon' }));

      const forkCall = mockForkSubagent.mock.calls[0]?.[0];
      // A provider IS set (the read-only recon fallback) — unlike a normal
      // skill with no factory, which gets `provider: undefined` (see the
      // "omits provider when no childProviderFactory is configured" test above).
      expect(forkCall?.config?.provider).toBeDefined();
      // The provider must be read-only — it must NOT grant write_file.
      // Introspect through the provider's permissions allowedTools list.
      const provider = forkCall?.config?.provider;
      const allowedTools: string[] | undefined = (provider as any)?.permissions?.allowedTools;
      expect(allowedTools, 'provider must have an allowedTools list').toBeDefined();
      expect(
        allowedTools?.includes('write_file'),
        'write_file must NOT be in the fallback provider allowedTools',
      ).toBe(false);
      expect(
        allowedTools?.includes('edit_file'),
        'edit_file must NOT be in the fallback provider allowedTools',
      ).toBe(false);
      // The provider must carry readOnlyBash: true so the dispatcher blocks
      // mutating bash commands — the other half of read-only enforcement.
      expect(
        (provider as any)?.readOnlyBash,
        'fallback provider must have readOnlyBash: true',
      ).toBe(true);
    });

    it('with NO factory, a NORMAL skill gets no provider (proves the fallback is read-only-gated)', async () => {
      const { mockForkSubagent } = captureForkConfig();
      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'p',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
        // childProviderFactory intentionally omitted.
      });

      const body: PluginSkillBody = {
        body: 'fake plugin body',
        pluginPath: '/fake/plugin',
        // readOnly omitted → normal read-write skill.
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (executor as any).pluginBodies = new Map([['fallback-normal', body]]);

      await executor.execute(makeCall({ name: 'fallback-normal' }));

      const forkCall = mockForkSubagent.mock.calls[0]?.[0];
      expect(forkCall?.config?.provider).toBeUndefined();
    });
  });

  describe('ctx.dispatchSkill', () => {
    // dispatchSkill is the in-handler callback that re-enters SkillExecutor.execute
    // so built-in TS handlers can reach plugin-only skills (e.g. shadow-verify).
    // The callback closes over the parent call's signal and routes through the
    // same registry → plugin-body lookup as the top-level `skill` tool.

    it('provides a dispatchSkill callback on the handler ctx', async () => {
      const handler = vi.fn().mockResolvedValue('ok');
      registerSkill({ name: 'host-skill', description: 'test', handler });

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'test',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
      });

      await executor.execute(makeCall({ name: 'host-skill' }));

      const ctxArg = handler.mock.calls[0]?.[2];
      expect(ctxArg).toBeDefined();
      expect(typeof ctxArg.dispatchSkill).toBe('function');
    });

    it('dispatches a registered skill from inside another handler', async () => {
      // Outer skill's handler calls dispatchSkill('inner') and returns the result.
      registerSkill({
        name: 'inner',
        description: 'inner',
        handler: vi.fn().mockResolvedValue('inner-result'),
      });
      registerSkill({
        name: 'outer',
        description: 'outer',
        handler: async (_input, _session, ctx) => {
          if (!ctx?.dispatchSkill) throw new Error('no dispatchSkill');
          return ctx.dispatchSkill('inner', 'inner-args');
        },
      });

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'test',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
      });

      const result = await executor.execute(makeCall({ name: 'outer' }));
      expect(result.isError).toBeUndefined();
      expect(result.content).toBe('inner-result');
    });

    it('forwards args verbatim to the dispatched skill', async () => {
      const innerHandler = vi.fn().mockResolvedValue('ok');
      registerSkill({ name: 'inner', description: 'inner', handler: innerHandler });
      registerSkill({
        name: 'outer',
        description: 'outer',
        handler: async (_input, _session, ctx) => {
          await ctx?.dispatchSkill?.('inner', JSON.stringify({ a: 1, b: 'two' }));
          return 'done';
        },
      });

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'test',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
      });

      await executor.execute(makeCall({ name: 'outer' }));
      expect(innerHandler).toHaveBeenCalledWith(
        '{"a":1,"b":"two"}',
        expect.anything(),
        expect.any(Object),
      );
    });

    it('omits the arguments field when called without args', async () => {
      const innerHandler = vi.fn().mockResolvedValue('ok');
      registerSkill({ name: 'inner', description: 'inner', handler: innerHandler });
      registerSkill({
        name: 'outer',
        description: 'outer',
        handler: async (_input, _session, ctx) => {
          await ctx?.dispatchSkill?.('inner');
          return 'done';
        },
      });

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'test',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
      });

      await executor.execute(makeCall({ name: 'outer' }));
      // No args → handler receives undefined for input arg
      expect(innerHandler).toHaveBeenCalledWith(undefined, expect.anything(), expect.any(Object));
    });

    it('throws when the dispatched skill returns isError: true', async () => {
      registerSkill({
        name: 'outer',
        description: 'outer',
        handler: async (_input, _session, ctx) => {
          // Dispatch an unknown skill — execute() returns isError: true
          try {
            await ctx?.dispatchSkill?.('does-not-exist');
            return 'unreachable';
          } catch (err) {
            return err instanceof Error ? err.message : String(err);
          }
        },
      });

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'test',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
      });

      const result = await executor.execute(makeCall({ name: 'outer' }));
      // The handler caught the throw and returned the error message
      expect(result.content).toContain('not found');
    });

    it('propagates the parent abort signal to the child dispatch', async () => {
      // If outer was already aborted, the inner dispatch sees the same signal.
      const ctl = new AbortController();
      let observedSignalAborted = false;
      registerSkill({
        name: 'inner',
        description: 'inner',
        handler: async () => {
          // Cannot directly observe signal here — but the SkillExecutor.execute
          // entry checks call.signal.aborted before dispatching. So if we abort
          // *between* outer entry and inner dispatch, inner returns the abort
          // sentinel.
          return 'ran';
        },
      });
      registerSkill({
        name: 'outer',
        description: 'outer',
        handler: async (_input, _session, ctx) => {
          ctl.abort();
          try {
            await ctx?.dispatchSkill?.('inner');
          } catch (err) {
            observedSignalAborted = err instanceof Error && /aborted/i.test(err.message);
          }
          return 'done';
        },
      });

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'test',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal: ctl.signal,
        },
      });

      await executor.execute({
        id: 'parent-call',
        name: 'skill',
        input: { name: 'outer' },
        signal: ctl.signal,
      });

      expect(observedSignalAborted).toBe(true);
    });
  });

  describe('plugin skill cancelled-with-partial-output paths', () => {
    it('cancelled plugin skill with partial output surfaces partial output and marker (not isError)', async () => {
      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockResolvedValue({
        runToResult: vi.fn().mockResolvedValue({
          status: 'cancelled',
          partialOutput: 'fetched 2 pages before abort',
        }),
        teardown: vi.fn().mockResolvedValue(undefined),
      } as never);
      vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'test',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
      });

      (executor as unknown as { pluginBodies: Map<string, PluginSkillBody> | null }).pluginBodies =
        new Map([['plugin-cancelled-partial', { body: 'plugin-body', pluginPath: '/fake/plugin', context: 'fork' }]]);

      const result = await executor.execute(makeCall({ name: 'plugin-cancelled-partial' }));

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('[skill cancelled mid-flight — partial output preserved below]');
      expect(result.content).toContain('fetched 2 pages before abort');
    });

    it('cancelled plugin skill with NO partial output returns isError=true (regression guard)', async () => {
      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockResolvedValue({
        runToResult: vi.fn().mockResolvedValue({
          status: 'cancelled',
          error: { message: 'plugin was cancelled' },
        }),
        teardown: vi.fn().mockResolvedValue(undefined),
      } as never);
      vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'test',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
      });

      (executor as unknown as { pluginBodies: Map<string, PluginSkillBody> | null }).pluginBodies =
        new Map([['plugin-cancelled-no-partial', { body: 'plugin-body', pluginPath: '/fake/plugin', context: 'fork' }]]);

      const result = await executor.execute(makeCall({ name: 'plugin-cancelled-no-partial' }));

      expect(result.isError).toBe(true);
      expect(result.content).toContain('plugin was cancelled');
    });
  });

  // ─── tools: allowlist propagation ────────────────────────────────────────

  describe('plugin skill tools: allowlist enforcement', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('calls buildSkillRestrictedProvider when allowedTools is present on the skill body', async () => {
      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockResolvedValue({
        runToResult: vi.fn().mockResolvedValue({
          status: 'succeeded',
          message: { content: 'restricted output' },
        }),
        teardown: vi.fn().mockResolvedValue(undefined),
      } as never);
      vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);

      const buildRestrictedSpy = vi.spyOn(nestingModule, 'buildSkillRestrictedProvider');

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'test',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
        defaultModel: 'sonnet',
      });

      // Inject a PluginSkillBody with allowedTools
      const skillBody: PluginSkillBody = {
        body: 'You are a read-only research assistant.',
        pluginPath: '/fake/plugin',
        // context: fork — required to reach the fork path post load-by-default flip.
        context: 'fork',
        allowedTools: ['read_file', 'grep', 'glob', 'list_directory'],
      };
      (executor as unknown as { pluginBodies: Map<string, PluginSkillBody> | null }).pluginBodies =
        new Map([['restricted-skill', skillBody]]);

      const result = await executor.execute(makeCall({ name: 'restricted-skill' }));

      expect(result.isError).toBeUndefined();
      expect(result.content).toBe('restricted output');
      expect(buildRestrictedSpy).toHaveBeenCalledWith(
        ['read_file', 'grep', 'glob', 'list_directory'],
        'sonnet',
      );
    });

    it('uses buildReadOnlyReconProvider (NOT buildSkillRestrictedProvider) for a read-only skill at the depth cap', async () => {
      // Regression guard for the cap-path readOnlyBash fail-open: a read-only
      // plugin skill forked without a childProviderFactory (the depth-cap / no-
      // factory branch) must get a provider that preserves the mutating-bash
      // gate. buildReadOnlyReconProvider carries readOnlyBash + readOnlyMemory +
      // RECON; buildSkillRestrictedProvider does not. So the readOnly branch must
      // win even when a tools: list is also declared — otherwise `bash` (a builtin
      // gated by readOnlyBash, not routed through an executor) re-opens at the cap.
      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockResolvedValue({
        runToResult: vi.fn().mockResolvedValue({
          status: 'succeeded',
          message: { content: 'recon output' },
        }),
        teardown: vi.fn().mockResolvedValue(undefined),
      } as never);
      vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);

      const reconSpy = vi.spyOn(nestingModule, 'buildReadOnlyReconProvider');
      const restrictedSpy = vi.spyOn(nestingModule, 'buildSkillRestrictedProvider');

      // No childProviderFactory on the executor → buildForkedChildConfig takes
      // the depth-cap / no-factory branch.
      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'test',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
        defaultModel: 'sonnet',
      });

      // Read-only skill that ALSO declares a tools: list including bash/write_file.
      const skillBody: PluginSkillBody = {
        body: 'You are a read-only auditor.',
        pluginPath: '/fake/plugin',
        // context: fork — required to reach the fork path post load-by-default flip.
        context: 'fork',
        readOnly: true,
        allowedTools: ['read_file', 'bash', 'write_file'],
      };
      (executor as unknown as { pluginBodies: Map<string, PluginSkillBody> | null }).pluginBodies =
        new Map([['recon-skill', skillBody]]);

      const result = await executor.execute(makeCall({ name: 'recon-skill' }));

      expect(result.isError).toBeUndefined();
      // readOnly wins: the recon provider (which keeps readOnlyBash) is used, and
      // the bare restricted provider that would drop the bash gate is NOT.
      expect(reconSpy).toHaveBeenCalledWith('sonnet');
      expect(restrictedSpy).not.toHaveBeenCalled();
    });

    it('does NOT call buildSkillRestrictedProvider when allowedTools is absent', async () => {
      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockResolvedValue({
        runToResult: vi.fn().mockResolvedValue({
          status: 'succeeded',
          message: { content: 'full-access output' },
        }),
        teardown: vi.fn().mockResolvedValue(undefined),
      } as never);
      vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);

      const buildRestrictedSpy = vi.spyOn(nestingModule, 'buildSkillRestrictedProvider');

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'test',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
      });

      // Inject a PluginSkillBody WITHOUT allowedTools (backward-compatible path)
      const skillBody: PluginSkillBody = {
        body: 'Do anything.',
        pluginPath: '/fake/plugin',
        // context: fork so the skill actually forks (load-by-default since 2026-06);
        // otherwise this test would pass vacuously via the in-context load path.
        context: 'fork',
      };
      (executor as unknown as { pluginBodies: Map<string, PluginSkillBody> | null }).pluginBodies =
        new Map([['unrestricted-skill', skillBody]]);

      await executor.execute(makeCall({ name: 'unrestricted-skill' }));

      // buildSkillRestrictedProvider must NOT be called for unrestricted skills
      expect(buildRestrictedSpy).not.toHaveBeenCalled();
    });

    it('passes the allowedTools list through to buildSkillRestrictedProvider verbatim', async () => {
      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockResolvedValue({
        runToResult: vi.fn().mockResolvedValue({
          status: 'succeeded',
          message: { content: 'ok' },
        }),
        teardown: vi.fn().mockResolvedValue(undefined),
      } as never);
      vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);

      const buildRestrictedSpy = vi.spyOn(nestingModule, 'buildSkillRestrictedProvider');

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'test',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
      });

      const narrowList = ['read_file', 'grep'];
      const skillBody: PluginSkillBody = {
        body: 'Read-only body.',
        pluginPath: '/p',
        // context: fork — required to reach the fork path post load-by-default flip.
        context: 'fork',
        allowedTools: narrowList,
      };
      (executor as unknown as { pluginBodies: Map<string, PluginSkillBody> | null }).pluginBodies =
        new Map([['narrow-skill', skillBody]]);

      await executor.execute(makeCall({ name: 'narrow-skill' }));

      expect(buildRestrictedSpy).toHaveBeenCalledWith(
        ['read_file', 'grep'],
        'sonnet',
      );
    });
  });

  describe('$ARGUMENT / $ARGUMENTS substitution in plugin SKILL.md body', () => {
    /**
     * Pins the substituteSkillArgs behaviour: the body passed as systemPrompt
     * to the forked sub-agent must have $ARGUMENT/$ARGUMENTS replaced with the
     * caller-supplied args string before the fork is configured.
     *
     * If these tests fail, do NOT just update assertions — the substitution
     * is what allows plugin skills (checkpoint, ship, mint, spec, …) to detect
     * mode/args from the system prompt. Removing it silently breaks those skills.
     */

    function captureSystemPrompt(skillName: string, body: string) {
      const mockForkSubagent = vi.fn().mockResolvedValue({
        runToResult: vi.fn().mockResolvedValue({
          status: 'succeeded',
          message: { content: 'ok' },
        }),
        teardown: vi.fn().mockResolvedValue(undefined),
      });
      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockImplementation(mockForkSubagent);
      vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'test',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
      });

      (executor as unknown as { pluginBodies: Map<string, PluginSkillBody> | null }).pluginBodies =
        new Map([[skillName, { body, pluginPath: '/fake/plugin', context: 'fork' }]]);

      return { executor, mockForkSubagent };
    }

    it('substitutes $ARGUMENT with args in the systemPrompt seen by the forked sub-agent', async () => {
      const body = 'Detect mode from `$ARGUMENT` and proceed.';
      const { executor, mockForkSubagent } = captureSystemPrompt('checkpoint', body);

      await executor.execute(makeCall({ name: 'checkpoint', arguments: 'save --label foo' }));

      expect(mockForkSubagent).toHaveBeenCalledOnce();
      const forkConfig = mockForkSubagent.mock.calls[0][0] as { config: { systemPrompt: string } };
      expect(forkConfig.config.systemPrompt).toBe(
        'Detect mode from `save --label foo` and proceed.',
      );
    });

    it('replaces $ARGUMENT with empty string when args is undefined', async () => {
      const body = 'Mode: $ARGUMENT — fallback to interactive if empty.';
      const { executor, mockForkSubagent } = captureSystemPrompt('checkpoint-no-args', body);

      await executor.execute(makeCall({ name: 'checkpoint-no-args' }));

      expect(mockForkSubagent).toHaveBeenCalledOnce();
      const forkConfig = mockForkSubagent.mock.calls[0][0] as { config: { systemPrompt: string } };
      expect(forkConfig.config.systemPrompt).toBe('Mode:  — fallback to interactive if empty.');
    });

    it('replaces $ARGUMENT with empty string when args is an empty string', async () => {
      const body = 'Args: [$ARGUMENT]';
      const { executor, mockForkSubagent } = captureSystemPrompt('checkpoint-empty', body);

      // `arguments: ''` reaches substituteSkillArgs as args='' — parseSkillInput
      // only treats `undefined` as absent, so this exercises the empty-string
      // branch. The args=undefined path is covered by the preceding test.
      await executor.execute(makeCall({ name: 'checkpoint-empty', arguments: '' }));

      expect(mockForkSubagent).toHaveBeenCalledOnce();
      const forkConfig = mockForkSubagent.mock.calls[0][0] as { config: { systemPrompt: string } };
      expect(forkConfig.config.systemPrompt).toBe('Args: []');
    });

    it('passes body through unchanged when it contains no $ARGUMENT placeholder', async () => {
      const body = 'This body has no placeholder — pass through verbatim.';
      const { executor, mockForkSubagent } = captureSystemPrompt('ship', body);

      await executor.execute(makeCall({ name: 'ship', arguments: 'some args' }));

      expect(mockForkSubagent).toHaveBeenCalledOnce();
      const forkConfig = mockForkSubagent.mock.calls[0][0] as { config: { systemPrompt: string } };
      expect(forkConfig.config.systemPrompt).toBe(body);
    });

    it('substitutes $ARGUMENTS (plural) as well as $ARGUMENT (singular)', async () => {
      const body = 'All args: $ARGUMENTS. First arg: $ARGUMENT.';
      const { executor, mockForkSubagent } = captureSystemPrompt('mint', body);

      await executor.execute(makeCall({ name: 'mint', arguments: 'approved' }));

      expect(mockForkSubagent).toHaveBeenCalledOnce();
      const forkConfig = mockForkSubagent.mock.calls[0][0] as { config: { systemPrompt: string } };
      expect(forkConfig.config.systemPrompt).toBe('All args: approved. First arg: approved.');
    });

    it('inserts args verbatim — $ sequences in args are not interpreted as replacement patterns', async () => {
      // Regression for the replacement-string footgun: String.prototype.replace
      // interprets $$, $&, $`, $', $n when the replacement is a STRING. args
      // must be substituted literally (function-form replacement), so a
      // commit-message-style arg containing `$&` / `$$` lands in the system
      // prompt unchanged rather than expanding to the matched token.
      const body = 'Mode: $ARGUMENT';
      const { executor, mockForkSubagent } = captureSystemPrompt('ship', body);

      await executor.execute(makeCall({ name: 'ship', arguments: '100% $& done $$ $1' }));

      expect(mockForkSubagent).toHaveBeenCalledOnce();
      const forkConfig = mockForkSubagent.mock.calls[0][0] as { config: { systemPrompt: string } };
      expect(forkConfig.config.systemPrompt).toBe('Mode: 100% $& done $$ $1');
    });

    it('does not alter the user-message fallback (named directive when no args)', async () => {
      // Regression guard: the substitution touches only the body/systemPrompt,
      // never the userMessage. The named-skill fallback must remain intact —
      // and free of any $ARGUMENT substitution — when args is absent.
      const body = 'Mode: $ARGUMENT';
      const mockRunToResult = vi.fn().mockResolvedValue({
        status: 'succeeded',
        message: { content: 'ok' },
      });
      vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockResolvedValue({
        runToResult: mockRunToResult,
        teardown: vi.fn().mockResolvedValue(undefined),
      } as never);
      vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'test',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
      });
      (executor as unknown as { pluginBodies: Map<string, PluginSkillBody> | null }).pluginBodies =
        new Map([['plugin-no-args', { body, pluginPath: '/fake/plugin', context: 'fork' }]]);

      await executor.execute(makeCall({ name: 'plugin-no-args' }));

      expect(mockRunToResult).toHaveBeenCalledWith(
        'Run the plugin-no-args skill now, following the instructions in your system prompt.',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // (d) skill-invocation-writer call-site wiring
  // ---------------------------------------------------------------------------
  describe('writeSkillInvocation wiring', () => {
    beforeEach(() => {
      mockWriteSkillInvocation.mockClear();
    });

    it('calls writeSkillInvocation once with correct skillName for an inline registry skill', async () => {
      // mockWriteSkillInvocation is hoisted and mocked at file scope via
      // vi.hoisted + vi.mock, so it is already in effect here.
      const handler = vi.fn().mockResolvedValue('wired output');
      registerSkill({
        name: 'wired-skill',
        description: 'Test wiring for writeSkillInvocation',
        handler,
      });

      const executor = new SkillExecutor({
        parentSession: {
          sessionId: 'sess-wiring-test',
          getInputStreamRef: () => ({ pushUserMessage: () => {} }),
          abortSignal,
        },
        defaultModel: 'sonnet',
        cwd: '/tmp/test-cwd',
      });

      await executor.execute(makeCall({ name: 'wired-skill', arguments: 'test args' }));

      expect(mockWriteSkillInvocation).toHaveBeenCalledOnce();
      const callArg = mockWriteSkillInvocation.mock.calls[0][0] as { skillName: string };
      expect(callArg.skillName).toBe('wired-skill');
    });
  });
});
