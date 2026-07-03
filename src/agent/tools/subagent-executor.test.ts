/**
 * Tests for SubagentExecutor
 *
 * Run with: npm test -- tests/agent/tools/subagent-executor.test.ts
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// Hoisted mock so SubagentExecutor picks up the mocked appendRoutingDecision.
const appendRoutingDecision = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../routing-telemetry.js', () => ({ appendRoutingDecision }));

// Mock the credential resolver so tests are not coupled to the live
// keychain / environment. Default: returns 'resolved-test-credential' for
// any Anthropic-routed model, undefined for openai-routed.
const mockResolveCredentialForModel = vi.hoisted(() =>
  vi.fn((_model: string | undefined) => 'resolved-test-credential' as string | undefined),
);
vi.mock('../auth/credential-resolver.js', () => ({
  resolveCredentialForModel: mockResolveCredentialForModel,
  loadAnthropicCredential: vi.fn(() => 'resolved-test-credential'),
  loadOpenAICredential: vi.fn(() => undefined),
}));

import type { SubagentHandle, SubagentResult } from '../subagent.js';
import type { IAgentSession } from '../types.js';
import type { AgentConfig } from '../types/config-types.js';
import type { ToolCall } from './types.js';
import type { ModelProvider } from '../provider.js';
import { SubagentExecutor, DEFAULT_MAX_NESTING_DEPTH, type SubagentExecutorContext } from './subagent-executor.js';

function mockHandle(
  overrides?: Partial<{
    status: string;
    message: { role: string; content: string; timestamp: Date };
    error: Error;
    /** In-turn SubagentStop note the executor appends to the tool_result. */
    injectContext: string;
  }>,
): Partial<SubagentHandle> {
  return {
    id: 'test-handle',
    status: (overrides?.status ?? 'succeeded') as any,
    runToResult: vi.fn().mockResolvedValue({
      id: 'test-handle',
      status: overrides?.status ?? 'succeeded',
      message: overrides?.message ?? {
        role: 'assistant',
        content: 'test output',
        timestamp: new Date(),
      },
      error: overrides?.error,
    } as SubagentResult),
    cancel: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn().mockResolvedValue(undefined),
    // Defaults to undefined (no note) so existing tests see unchanged content.
    // The in-turn-delivery suite overrides this to assert the append.
    getLastStopInjectContext: vi.fn().mockReturnValue(overrides?.injectContext),
  };
}

/** Make a handle whose runToResult blocks until the returned resolve fn is called. */
function hangingHandle() {
  const handle = mockHandle();
  let resolveRun!: (value: SubagentResult) => void;
  (handle.runToResult as any).mockReturnValue(
    new Promise<SubagentResult>((r) => { resolveRun = r; }),
  );
  return { handle, resolveRun: (v: SubagentResult) => resolveRun(v) };
}

function mockManager(
  handle?: Partial<SubagentHandle>,
): Partial<{ forkSubagent: typeof vi.fn }> {
  return {
    forkSubagent: vi.fn().mockResolvedValue(handle ?? mockHandle()),
  };
}

function makeCall(overrides?: Partial<ToolCall>): ToolCall {
  return {
    id: 'test-call',
    name: 'agent',
    input: { prompt: 'do something' },
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('SubagentExecutor', () => {
  let executor: SubagentExecutor;
  let mockSubagentMgr: Partial<{ forkSubagent: typeof vi.fn }>;
  let mockParentSession: Partial<IAgentSession>;
  let mockConfig: Pick<AgentConfig, 'apiKey' | 'systemPrompt'>;

  beforeEach(() => {
    mockSubagentMgr = mockManager();
    mockParentSession = {
      sessionId: 'parent-session-id',
      getInputStreamRef: vi.fn(),
      abortSignal: new AbortController().signal,
    };
    mockConfig = {
      apiKey: 'test-key',
      systemPrompt: 'test system prompt',
    };

    const ctx: SubagentExecutorContext = {
      subagentManager: mockSubagentMgr as any,
      parentSession: mockParentSession as any,
      defaultConfig: mockConfig,
      depth: 0,
    };

    executor = new SubagentExecutor(ctx);
  });

  describe('input validation', () => {
    it('returns error when prompt is missing', async () => {
      const call = makeCall({ input: {} });
      const result = await executor.execute(call);

      expect(result.isError).toBe(true);
      expect(result.content).toContain('prompt');
    });

    it('returns error when prompt is empty string', async () => {
      const call = makeCall({ input: { prompt: '' } });
      const result = await executor.execute(call);

      expect(result.isError).toBe(true);
      expect(result.content).toContain('empty');
    });

    it('returns error when input is not an object', async () => {
      const call = makeCall({ input: 'not an object' });
      const result = await executor.execute(call);

      expect(result.isError).toBe(true);
      expect(result.content).toContain('object');
    });

    it('clamps max_turns to 1-50 range', async () => {
      const handle = mockHandle();
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      // Test clamping high
      await executor.execute(
        makeCall({ input: { prompt: 'test', max_turns: 100 } }),
      );
      expect(mockSubagentMgr.forkSubagent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ maxTurns: 50 }),
        }),
      );

      // Test clamping low
      (mockSubagentMgr.forkSubagent as ReturnType<typeof vi.fn>).mockClear();
      await executor.execute(
        makeCall({ input: { prompt: 'test', max_turns: -5 } }),
      );
      expect(mockSubagentMgr.forkSubagent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ maxTurns: 1 }),
        }),
      );
    });

    it('uses defaults for optional fields', async () => {
      const handle = mockHandle();
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      await executor.execute(makeCall({ input: { prompt: 'test' } }));

      // apiKey is now resolved by the agent-layer credential resolver
      // (resolveCredentialForModel), not forwarded verbatim from defaultConfig.
      // The mock returns 'resolved-test-credential' for Anthropic-routed models.
      expect(mockSubagentMgr.forkSubagent).toHaveBeenCalledWith(
        expect.objectContaining({
          idPrefix: 'agent-tool',
          config: expect.objectContaining({
            maxTurns: 10,
            model: 'sonnet',
            apiKey: 'resolved-test-credential',
            systemPrompt: 'test system prompt',
          }),
        }),
      );
    });
  });

  describe('successful dispatch', () => {
    it('forks subagent and returns message content', async () => {
      const expectedContent = 'subagent response';
      const handle = mockHandle({
        message: {
          role: 'assistant',
          content: expectedContent,
          timestamp: new Date(),
        },
      });
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      const result = await executor.execute(makeCall());

      expect(result.content).toBe(expectedContent);
      expect(result.isError).toBeUndefined();
    });

    it('passes model override to child config', async () => {
      const handle = mockHandle();
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      await executor.execute(
        makeCall({ input: { prompt: 'test', model: 'opus' } }),
      );

      expect(mockSubagentMgr.forkSubagent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ model: 'opus' }),
        }),
      );
    });

    it('passes id_prefix to forkSubagent', async () => {
      const handle = mockHandle();
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      await executor.execute(
        makeCall({ input: { prompt: 'test', id_prefix: 'custom-prefix' } }),
      );

      expect(mockSubagentMgr.forkSubagent).toHaveBeenCalledWith(
        expect.objectContaining({
          idPrefix: 'custom-prefix',
        }),
      );
    });
  });

  // Per-call cwd parameter — Phase 1 of model-facing worktree isolation.
  //
  // Wires the `cwd` field on AgentInput → AgentConfig.cwd → SubagentManager
  // forkSubagent (where `options.config.cwd` wins over `parentCwd` per
  // subagent.ts:291-297). The dispatched subagent's tool dispatcher then
  // anchors resolveBase + read/write roots at the new cwd.
  //
  // Validation contract (format-only — existence is not checked):
  //   1. Must be a non-empty string when present.
  //   2. Must be absolute.
  //   3. Must not contain `..` as a path segment.
  // A non-existent path surfaces as ENOENT on the child's first
  // cwd-relative tool call rather than failing at parse time — the
  // parser is sync and shouldn't shell out for stat.
  describe('cwd parameter', () => {
    it('threads parsed.cwd into childConfig.cwd when present', async () => {
      const handle = mockHandle();
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      await executor.execute(
        makeCall({ input: { prompt: 'test', cwd: '/tmp/wt/feat-x' } }),
      );

      expect(mockSubagentMgr.forkSubagent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ cwd: '/tmp/wt/feat-x' }),
        }),
      );
    });

    it('omits cwd from childConfig when not provided (parent fallback preserved)', async () => {
      const handle = mockHandle();
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      await executor.execute(makeCall({ input: { prompt: 'test' } }));

      // The childConfig object passed to forkSubagent must not carry a
      // `cwd` key at all — SubagentManager's `parentCwd` fallback only
      // engages when `options.config.cwd === undefined`. Asserting on
      // the call argument's own-key presence (not just value) prevents
      // a regression where we accidentally pass `cwd: undefined`, which
      // would still satisfy `=== undefined` but trip strictness checks.
      const call = (mockSubagentMgr.forkSubagent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(call).toBeDefined();
      expect(Object.prototype.hasOwnProperty.call(call.config, 'cwd')).toBe(false);
    });

    it('rejects non-string cwd', async () => {
      const result = await executor.execute(
        makeCall({ input: { prompt: 'test', cwd: 42 } }),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('cwd must be a string');
    });

    it('rejects empty-string cwd', async () => {
      const result = await executor.execute(
        makeCall({ input: { prompt: 'test', cwd: '' } }),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('non-empty');
    });

    it('rejects relative cwd', async () => {
      const result = await executor.execute(
        makeCall({ input: { prompt: 'test', cwd: 'relative/path' } }),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('absolute');
    });

    it('rejects dot-relative cwd', async () => {
      const result = await executor.execute(
        makeCall({ input: { prompt: 'test', cwd: './also-relative' } }),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('absolute');
    });

    it('rejects cwd containing .. segment', async () => {
      const result = await executor.execute(
        makeCall({ input: { prompt: 'test', cwd: '/tmp/wt/../escape' } }),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("'..'");
    });

    it('rejects cwd with .. segment using backslash separator (Windows-shape input)', async () => {
      // Defense-in-depth: even on POSIX hosts, a Windows-formatted path
      // containing a backslash-delimited '..' must be rejected. The split
      // regex covers both separators so the check holds regardless of
      // execution host. isAbsolute() will reject the Windows path on a
      // POSIX host first, but we test the segment check on an absolute
      // POSIX path that mixes separators to exercise the split branch.
      const result = await executor.execute(
        makeCall({ input: { prompt: 'test', cwd: '/tmp\\..\\escape' } }),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("'..'");
    });
  });

  describe('default model resolution', () => {
    it('uses defaultSubagentModel when parsed.model is omitted', async () => {
      const handle = mockHandle();
      const manager = mockManager(handle);
      const exec = new SubagentExecutor({
        subagentManager: manager as any,
        parentSession: mockParentSession as any,
        defaultConfig: { apiKey: 'k', systemPrompt: 'sp' },
        defaultSubagentModel: 'haiku',
        depth: 0,
      });

      await exec.execute(makeCall({ input: { prompt: 'test' } }));

      expect(manager.forkSubagent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ model: 'haiku' }),
        }),
      );
    });

    it("falls back to 'sonnet' when defaultSubagentModel is unset", async () => {
      const handle = mockHandle();
      const manager = mockManager(handle);
      const exec = new SubagentExecutor({
        subagentManager: manager as any,
        parentSession: mockParentSession as any,
        defaultConfig: { apiKey: 'k', systemPrompt: 'sp' },
        depth: 0,
      });

      await exec.execute(makeCall({ input: { prompt: 'test' } }));

      expect(manager.forkSubagent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ model: 'sonnet' }),
        }),
      );
    });

    it('parsed.model wins over defaultSubagentModel', async () => {
      const handle = mockHandle();
      const manager = mockManager(handle);
      const exec = new SubagentExecutor({
        subagentManager: manager as any,
        parentSession: mockParentSession as any,
        defaultConfig: { apiKey: 'k', systemPrompt: 'sp' },
        defaultSubagentModel: 'haiku',
        depth: 0,
      });

      await exec.execute(makeCall({ input: { prompt: 'test', model: 'opus' } }));

      expect(manager.forkSubagent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ model: 'opus' }),
        }),
      );
    });
  });

  describe('resolveApiKeyForModel — per-model credential resolution', () => {
    // Regression: "Anthropic child starves when parent is OpenAI-routed."
    //
    // `getApiKey()` captures ONE credential keyed to the *main* model at
    // bootstrap. When the main model is OpenAI-routed, that credential is an
    // OpenAI key (or undefined) — but `agent`/`skill` children default to
    // 'sonnet' (Anthropic-routed) and need an Anthropic keychain/env
    // credential. Forwarding the parent's pre-captured apiKey verbatim made
    // the Anthropic child throw AnthropicDirectProvider's "requires
    // config.apiKey". The fix injects a resolver that re-derives the
    // credential by the *child's* model at fork time.
    // See subagent-executor.ts: resolvedChildApiKey wiring.

    it('resolves the child apiKey by the child model, not the parent defaultConfig.apiKey', async () => {
      // Parent is OpenAI-routed: defaultConfig.apiKey is the OpenAI credential.
      // The Anthropic-routed 'sonnet' child must NOT inherit it — it must get
      // the Anthropic credential the resolver returns for its own model.
      const resolveApiKeyForModel = vi.fn((model: string) =>
        model === 'sonnet' ? 'anthropic-keychain-token' : 'openai-key',
      );
      const handle = mockHandle();
      const manager = mockManager(handle);
      const exec = new SubagentExecutor({
        subagentManager: manager as any,
        parentSession: mockParentSession as any,
        defaultConfig: { apiKey: 'openai-key', systemPrompt: 'sp' },
        resolveApiKeyForModel,
        depth: 0,
      });

      await exec.execute(makeCall({ input: { prompt: 'test' } }));

      expect(resolveApiKeyForModel).toHaveBeenCalledWith('sonnet');
      expect(manager.forkSubagent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ apiKey: 'anthropic-keychain-token' }),
        }),
      );
    });

    it('resolves by the explicit per-call model override', async () => {
      const resolveApiKeyForModel = vi.fn(() => 'resolved-for-opus');
      const handle = mockHandle();
      const manager = mockManager(handle);
      const exec = new SubagentExecutor({
        subagentManager: manager as any,
        parentSession: mockParentSession as any,
        defaultConfig: { apiKey: 'parent-key', systemPrompt: 'sp' },
        resolveApiKeyForModel,
        depth: 0,
      });

      await exec.execute(makeCall({ input: { prompt: 'test', model: 'opus' } }));

      expect(resolveApiKeyForModel).toHaveBeenCalledWith('opus');
      expect(manager.forkSubagent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ apiKey: 'resolved-for-opus' }),
        }),
      );
    });

    it('calls resolveCredentialForModel directly when no resolver is injected', async () => {
      // New behavior (refactor/relocate-credential-resolver): when no
      // resolveApiKeyForModel is injected, the executor calls
      // resolveCredentialForModel from the agent layer directly — rather than
      // falling back to defaultConfig.apiKey. This eliminates the injection
      // threading while preserving the anti-leak invariant.
      const handle = mockHandle();
      const manager = mockManager(handle);
      const exec = new SubagentExecutor({
        subagentManager: manager as any,
        parentSession: mockParentSession as any,
        defaultConfig: { apiKey: 'parent-key', systemPrompt: 'sp' },
        depth: 0,
      });

      await exec.execute(makeCall({ input: { prompt: 'test' } }));

      // resolveCredentialForModel is called (mocked to return
      // 'resolved-test-credential') — NOT defaultConfig.apiKey.
      expect(mockResolveCredentialForModel).toHaveBeenCalledWith('sonnet');
      expect(manager.forkSubagent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ apiKey: 'resolved-test-credential' }),
        }),
      );
    });

    it('falls back to the parent Anthropic credential when per-model resolution is empty (expired-keychain regression)', async () => {
      // Regression: keychain-authenticated parent + expired OAuth token. The
      // sync keychain reader returns undefined for the 'sonnet' child, so the
      // resolver yields nothing. The child must inherit the parent's
      // bootstrap-captured Anthropic credential so it has a token to attempt
      // with (its own 401 refresher then self-heals) — instead of dying at the
      // provider pre-flight. See child-credential.ts.
      const resolveApiKeyForModel = vi.fn(() => undefined);
      const handle = mockHandle();
      const manager = mockManager(handle);
      const exec = new SubagentExecutor({
        subagentManager: manager as any,
        parentSession: mockParentSession as any,
        defaultConfig: { apiKey: 'sk-ant-oat01-PARENT', systemPrompt: 'sp' },
        resolveApiKeyForModel,
        depth: 0,
      });

      await exec.execute(makeCall({ input: { prompt: 'test' } }));

      expect(resolveApiKeyForModel).toHaveBeenCalledWith('sonnet');
      expect(manager.forkSubagent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ apiKey: 'sk-ant-oat01-PARENT' }),
        }),
      );
    });

    it('does NOT fall back to an OpenAI-shaped parent credential for an Anthropic child (anti-leak)', async () => {
      // Empty resolution + OpenAI-shaped parent credential: the Anthropic child
      // must be left credential-less rather than inherit the OpenAI key.
      const resolveApiKeyForModel = vi.fn(() => undefined);
      const handle = mockHandle();
      const manager = mockManager(handle);
      const exec = new SubagentExecutor({
        subagentManager: manager as any,
        parentSession: mockParentSession as any,
        defaultConfig: { apiKey: 'sk-proj-OPENAI', systemPrompt: 'sp' },
        resolveApiKeyForModel,
        depth: 0,
      });

      await exec.execute(makeCall({ input: { prompt: 'test' } }));

      expect(manager.forkSubagent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ apiKey: undefined }),
        }),
      );
    });

    it('preserves the cross-provider anti-leak guard: an OpenAI-routed child never receives an Anthropic credential', async () => {
      // Even though the resolver would return a key for the OpenAI child, the
      // childIsOpenAI guard forces apiKey: undefined — the openai-compatible
      // provider reads OPENAI_API_KEY from env directly. This defense-in-depth
      // layer must survive the resolver injection.
      const resolveApiKeyForModel = vi.fn(() => 'anthropic-token-must-not-leak');
      const handle = mockHandle();
      const manager = mockManager(handle);
      const exec = new SubagentExecutor({
        subagentManager: manager as any,
        parentSession: mockParentSession as any,
        defaultConfig: { apiKey: 'anthropic-token-must-not-leak', systemPrompt: 'sp' },
        resolveApiKeyForModel,
        depth: 0,
      });

      await exec.execute(makeCall({ input: { prompt: 'test', model: 'gpt-5' } }));

      expect(manager.forkSubagent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ apiKey: undefined, model: 'gpt-5' }),
        }),
      );
    });
  });

  describe('failure handling', () => {
    it('returns isError when subagent fails', async () => {
      const expectedError = new Error('subagent failed');
      const handle = mockHandle({ status: 'failed', error: expectedError });
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      const result = await executor.execute(makeCall());

      expect(result.isError).toBe(true);
      expect(result.content).toContain('subagent failed');
    });

    it('returns isError when forkSubagent throws', async () => {
      const expectedError = new Error('fork failed');
      mockSubagentMgr.forkSubagent = vi
        .fn()
        .mockRejectedValue(expectedError);

      const result = await executor.execute(makeCall());

      expect(result.isError).toBe(true);
      expect(result.content).toContain('fork failed');
    });

    it('returns fallback error message when subagent has no output', async () => {
      const handle = mockHandle({ status: 'failed', error: undefined });
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      const result = await executor.execute(makeCall());

      expect(result.isError).toBe(true);
      expect(result.content).toContain('no output');
    });
  });

  // Audit §F.1: structured failure payload. The parent model must be able to
  // distinguish hard failure, schema mismatch, and partial output rather than
  // receiving a flattened error string.
  describe('structured failure payload (audit §F.1)', () => {
    it('success path returns message content verbatim (unchanged)', async () => {
      const handle = mockHandle({
        message: { role: 'assistant', content: 'plain success body', timestamp: new Date() },
      });
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      const result = await executor.execute(makeCall());

      expect(result.isError).toBeUndefined();
      expect(result.content).toBe('plain success body');
      // Sanity: content is NOT JSON-shaped — success path stays raw text.
      expect(() => JSON.parse(result.content)).toThrow();
    });

    // T-1 (review finding C-1): when the SDK returns a ContentBlock[] array
    // instead of a plain string, the executor must serialize it to a string
    // so ToolResult.content is always a valid string.
    it('success path serializes non-string content (array) to a valid JSON string', async () => {
      const arrayContent = [{ type: 'text', text: 'hello from array' }];
      const handle = mockHandle({
        message: { role: 'assistant', content: arrayContent as unknown as string, timestamp: new Date() },
      });
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      const result = await executor.execute(makeCall());

      expect(result.isError).toBeUndefined();
      // Must be a string, not an object
      expect(typeof result.content).toBe('string');
      // Must round-trip as JSON (serialized form of the array)
      const parsed = JSON.parse(result.content);
      expect(parsed).toEqual(arrayContent);
    });

    it('failure returns JSON with status, error, and subagent_id', async () => {
      const handle = mockHandle({
        status: 'failed',
        error: new Error('something exploded'),
      });
      // Override id so we can assert it propagates.
      (handle as any).id = 'child-fail-1';
      (handle.runToResult as any).mockResolvedValue({
        id: 'child-fail-1',
        status: 'failed',
        error: new Error('something exploded'),
        message: undefined,
      });
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      const result = await executor.execute(makeCall());

      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content);
      expect(payload).toMatchObject({
        status: 'failed',
        error: 'something exploded',
        subagent_id: 'child-fail-1',
      });
      // Absent fields stay absent — payload is minimal.
      expect(payload.schemaError).toBeUndefined();
      expect(payload.partialOutput).toBeUndefined();
    });

    it('schema failure includes schemaError as a string', async () => {
      const handle = mockHandle({
        status: 'failed',
      });
      (handle as any).id = 'child-schema-1';
      (handle.runToResult as any).mockResolvedValue({
        id: 'child-schema-1',
        status: 'failed',
        error: new Error('structured output did not match schema: expected string'),
        schemaError: { message: 'expected string, got number' },
        message: undefined,
      });
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      const result = await executor.execute(makeCall());

      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content);
      expect(payload.schemaError).toBe('expected string, got number');
      expect(payload.subagent_id).toBe('child-schema-1');
      expect(payload.status).toBe('failed');
    });

    it('partialOutput is included only when present', async () => {
      // Case A: partialOutput present and small → passed through.
      const handleA = mockHandle({ status: 'failed' });
      (handleA as any).id = 'child-partial-a';
      (handleA.runToResult as any).mockResolvedValue({
        id: 'child-partial-a',
        status: 'failed',
        error: new Error('halted'),
        partialOutput: { steps: ['a', 'b'], note: 'made it halfway' },
        message: undefined,
      });
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handleA);

      const resultA = await executor.execute(makeCall());
      const payloadA = JSON.parse(resultA.content);
      expect(payloadA.partialOutput).toEqual({ steps: ['a', 'b'], note: 'made it halfway' });

      // Case B: partialOutput absent → key omitted entirely.
      const handleB = mockHandle({ status: 'failed' });
      (handleB as any).id = 'child-partial-b';
      (handleB.runToResult as any).mockResolvedValue({
        id: 'child-partial-b',
        status: 'failed',
        error: new Error('halted'),
        message: undefined,
      });
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handleB);

      const resultB = await executor.execute(makeCall());
      const payloadB = JSON.parse(resultB.content);
      expect('partialOutput' in payloadB).toBe(false);
    });

    it('over-large partialOutput is replaced by a truncated marker (size guard)', async () => {
      // ~10KB of partial output — well past the 4KB cap.
      const big = { blob: 'x'.repeat(10_000) };
      const handle = mockHandle({ status: 'failed' });
      (handle as any).id = 'child-big';
      (handle.runToResult as any).mockResolvedValue({
        id: 'child-big',
        status: 'failed',
        error: new Error('halted'),
        partialOutput: big,
        message: undefined,
      });
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      const result = await executor.execute(makeCall());
      const payload = JSON.parse(result.content);
      expect(payload.partialOutput).toEqual({
        truncated: true,
        chars: expect.any(Number),
      });
      // The raw blob must not be inlined.
      expect(result.content).not.toContain('xxxxxxxxxx');
    });

    it('fallback error message is preserved in the structured payload', async () => {
      const handle = mockHandle({ status: 'failed', error: undefined });
      (handle as any).id = 'child-no-output';
      (handle.runToResult as any).mockResolvedValue({
        id: 'child-no-output',
        status: 'failed',
        error: undefined,
        message: undefined,
      });
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      const result = await executor.execute(makeCall());

      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content);
      expect(payload.error).toBe('Subagent failed with no output');
      expect(payload.status).toBe('failed');
      expect(payload.subagent_id).toBe('child-no-output');
    });

    it('error message in payload is truncated to bound payload size', async () => {
      const huge = 'E'.repeat(5000);
      const handle = mockHandle({ status: 'failed' });
      (handle as any).id = 'child-huge-err';
      (handle.runToResult as any).mockResolvedValue({
        id: 'child-huge-err',
        status: 'failed',
        error: new Error(huge),
        message: undefined,
      });
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      const result = await executor.execute(makeCall());
      const payload = JSON.parse(result.content);
      // 1024-char cap + 1 ellipsis char.
      expect(payload.error.length).toBeLessThanOrEqual(1025);
    });

    it('thrown runToResult behavior is preserved (re-throws, does not return)', async () => {
      // runToResult rejecting should propagate — Phase 3 must not convert
      // a thrown error into a structured ToolResult.
      const handle: Partial<SubagentHandle> = {
        id: 'child-throw',
        status: 'failed' as any,
        runToResult: vi.fn().mockRejectedValue(new Error('Response timeout')),
        cancel: vi.fn().mockResolvedValue(undefined),
        teardown: vi.fn().mockResolvedValue(undefined),
      };
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      await expect(executor.execute(makeCall())).rejects.toThrow('Response timeout');
    });
  });

  describe('abort handling', () => {
    it('returns abort error when signal already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const call = makeCall({ signal: controller.signal });
      const result = await executor.execute(call);

      expect(result.isError).toBe(true);
      expect(result.content).toContain('aborted');
    });

    it('cancels handle when signal fires during execution', async () => {
      const controller = new AbortController();
      const { handle, resolveRun } = hangingHandle();
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      const executePromise = executor.execute(makeCall({ signal: controller.signal }));
      await new Promise((r) => setTimeout(r, 10));
      controller.abort();
      await new Promise((r) => setTimeout(r, 10));
      resolveRun({ id: 'test-handle', status: 'succeeded', message: { role: 'assistant', content: 'test', timestamp: new Date() } });

      await executePromise;
      expect(handle.cancel).toHaveBeenCalled();
    });
  });

  describe('teardown', () => {
    it('calls teardown on success', async () => {
      const handle = mockHandle();
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      await executor.execute(makeCall());

      expect(handle.teardown).toHaveBeenCalled();
    });

    it('calls teardown on failure', async () => {
      const handle = mockHandle({ status: 'failed', error: new Error('fail') });
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      await executor.execute(makeCall());

      expect(handle.teardown).toHaveBeenCalled();
    });

    it('calls teardown on abort', async () => {
      const controller = new AbortController();
      const { handle, resolveRun } = hangingHandle();
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      const executePromise = executor.execute(makeCall({ signal: controller.signal }));
      await new Promise((r) => setTimeout(r, 10));
      controller.abort();
      await new Promise((r) => setTimeout(r, 10));
      resolveRun({ id: 'test-handle', status: 'cancelled' });

      await executePromise;
      expect(handle.teardown).toHaveBeenCalled();
    });

    it('removes abort listener after execution', async () => {
      const handle = mockHandle();
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      const call = makeCall();
      const removeEventListenerSpy = vi.spyOn(
        call.signal,
        'removeEventListener',
      );

      await executor.execute(call);

      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        'abort',
        expect.any(Function),
      );
    });
  });

  describe('nesting', () => {
    function mockProvider(): ModelProvider {
      return {
        name: 'test-provider',
        query: vi.fn(),
      };
    }

    function makeNestingExecutor(overrides?: Partial<SubagentExecutorContext>): {
      executor: SubagentExecutor;
      manager: ReturnType<typeof mockManager>;
      factory: ReturnType<typeof vi.fn>;
    } {
      const manager = mockManager();
      const factory = vi.fn().mockReturnValue(mockProvider());
      const ctx: SubagentExecutorContext = {
        subagentManager: manager as any,
        parentSession: {
          sessionId: 'parent-session-id',
          getInputStreamRef: vi.fn(),
          abortSignal: new AbortController().signal,
        },
        defaultConfig: {
          apiKey: 'test-key',
          systemPrompt: 'test system prompt',
        },
        childProviderFactory: factory,
        depth: 0,
        maxDepth: DEFAULT_MAX_NESTING_DEPTH,
        ...overrides,
      };
      return { executor: new SubagentExecutor(ctx), manager, factory };
    }

    it('sets childConfig.provider via factory when nesting is enabled', async () => {
      const { executor: nestingExec, manager, factory } = makeNestingExecutor();

      await nestingExec.execute(makeCall());

      const forkCall = (manager.forkSubagent as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
      const config = (forkCall[0] as { config: AgentConfig }).config;
      expect(config.provider).toBeDefined();
      expect(factory).toHaveBeenCalledOnce();
      expect(factory).toHaveBeenCalledWith(expect.objectContaining({
        childExecutor: expect.any(SubagentExecutor),
      }));
    });

    it('increments depth on child executor', async () => {
      const { executor: nestingExec, factory } = makeNestingExecutor({ depth: 1 });

      await nestingExec.execute(makeCall());

      const args = factory.mock.calls[0]![0] as { childExecutor: SubagentExecutor };
      expect(args.childExecutor).toBeInstanceOf(SubagentExecutor);
    });

    it('does not set provider when at maxDepth', async () => {
      const { executor: nestingExec, manager, factory } = makeNestingExecutor({
        depth: 3,
        maxDepth: 3,
      });

      await nestingExec.execute(makeCall());

      const forkCall = (manager.forkSubagent as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
      const config = (forkCall[0] as { config: AgentConfig }).config;
      expect(config.provider).toBeUndefined();
      expect(factory).not.toHaveBeenCalled();
    });

    it('does not set provider when no factory is provided', async () => {
      // Uses the base executor from beforeEach (no factory)
      const handle = mockHandle();
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      await executor.execute(makeCall());

      const forkCall = (mockSubagentMgr.forkSubagent as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
      const config = (forkCall[0] as { config: AgentConfig }).config;
      expect(config.provider).toBeUndefined();
    });

    it('tears down child manager on success', async () => {
      const { executor: nestingExec } = makeNestingExecutor();
      // Spy on SubagentManager.prototype.teardownAll to verify it's called
      const teardownSpy = vi.fn().mockResolvedValue(undefined);
      const origSubagentManager = await import('../subagent.js');
      const ctorSpy = vi.spyOn(origSubagentManager, 'SubagentManager').mockImplementation((() => ({
        teardownAll: teardownSpy,
        list: () => [],
        killAll: vi.fn(),
      })) as any);

      try {
        await nestingExec.execute(makeCall());
        expect(teardownSpy).toHaveBeenCalledOnce();
      } finally {
        ctorSpy.mockRestore();
      }
    });

    it('tears down child manager on failure', async () => {
      const manager = mockManager(mockHandle({ status: 'failed', error: new Error('fail') }));
      const factory = vi.fn().mockReturnValue(mockProvider());
      const teardownSpy = vi.fn().mockResolvedValue(undefined);
      const origSubagentManager = await import('../subagent.js');
      const ctorSpy = vi.spyOn(origSubagentManager, 'SubagentManager').mockImplementation((() => ({
        teardownAll: teardownSpy,
        list: () => [],
        killAll: vi.fn(),
      })) as any);

      const nestingExec = new SubagentExecutor({
        subagentManager: manager as any,
        parentSession: {
          sessionId: 'parent',
          getInputStreamRef: vi.fn(),
          abortSignal: new AbortController().signal,
        },
        defaultConfig: { apiKey: 'k', systemPrompt: 'sp' },
        childProviderFactory: factory,
        depth: 0,
      });

      try {
        await nestingExec.execute(makeCall());
        expect(teardownSpy).toHaveBeenCalledOnce();
      } finally {
        ctorSpy.mockRestore();
      }
    });

    it('uses default maxDepth when not specified', async () => {
      const manager = mockManager();
      const factory = vi.fn().mockReturnValue(mockProvider());
      const depthAtMax = new SubagentExecutor({
        subagentManager: manager as any,
        parentSession: {
          sessionId: 'parent',
          getInputStreamRef: vi.fn(),
          abortSignal: new AbortController().signal,
        },
        defaultConfig: { apiKey: 'k', systemPrompt: 'sp' },
        childProviderFactory: factory,
        depth: DEFAULT_MAX_NESTING_DEPTH,
        // maxDepth omitted — should default to DEFAULT_MAX_NESTING_DEPTH
      });

      await depthAtMax.execute(makeCall());

      const forkCall = (manager.forkSubagent as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
      const config = (forkCall[0] as { config: AgentConfig }).config;
      expect(config.provider).toBeUndefined();
      expect(factory).not.toHaveBeenCalled();
    });

    it('B1: forwards ctx.allowedTools and ctx.readOnlyBash into childProviderFactory and recursive child executor', async () => {
      // When a read-only skill's child SubagentExecutor fans out via `agent`,
      // the grandchild provider must receive allowedTools + readOnlyBash so the
      // constraint survives depth-2+ fan-out (ground-state → agent → depth-2).
      const RECON_TOOLS = ['read_file', 'glob', 'grep', 'list_directory', 'bash', 'agent', 'skill'];
      let capturedChildExecutorCtx: SubagentExecutorContext | undefined;

      const factory = vi.fn().mockImplementation(({ childExecutor }: { childExecutor: SubagentExecutor }) => {
        capturedChildExecutorCtx = (childExecutor as any).ctx as SubagentExecutorContext;
        return { name: 'p', query: vi.fn() };
      });

      const manager = mockManager();
      const exec = new SubagentExecutor({
        subagentManager: manager as any,
        parentSession: {
          sessionId: 'root',
          getInputStreamRef: vi.fn(),
          abortSignal: new AbortController().signal,
        },
        defaultConfig: { apiKey: 'k', systemPrompt: 'sp' },
        childProviderFactory: factory,
        depth: 0,
        maxDepth: DEFAULT_MAX_NESTING_DEPTH,
        allowedTools: RECON_TOOLS,
        readOnlyBash: true,
      });

      await exec.execute(makeCall());

      // (1) childProviderFactory was called with allowedTools and readOnlyBash spread in.
      expect(factory).toHaveBeenCalledWith(
        expect.objectContaining({
          allowedTools: RECON_TOOLS,
          readOnlyBash: true,
        }),
      );

      // (2) The recursive child SubagentExecutor also received both fields,
      //     so depth-3+ forks remain gated.
      expect(capturedChildExecutorCtx).toBeDefined();
      expect(capturedChildExecutorCtx!.allowedTools).toEqual(RECON_TOOLS);
      expect(capturedChildExecutorCtx!.readOnlyBash).toBe(true);
    });
  });

  // Regression: Edit B — forkSubagent must receive parentId: call.id so
  // depth-1 subagents are attributed correctly in the stream-renderer.
  describe('parentId attribution (regression fix/stream-renderer-nested-attribution)', () => {
    function makeNestingExecutor2(overrides?: Partial<SubagentExecutorContext>): {
      executor: SubagentExecutor;
      manager: ReturnType<typeof mockManager>;
    } {
      const manager = mockManager();
      const ctx: SubagentExecutorContext = {
        subagentManager: manager as any,
        parentSession: {
          sessionId: 'parent-session-id',
          getInputStreamRef: vi.fn(),
          abortSignal: new AbortController().signal,
        },
        defaultConfig: { apiKey: 'k', systemPrompt: 'sp' },
        childProviderFactory: vi.fn().mockReturnValue({ name: 'p', query: vi.fn() }),
        depth: 0,
        maxDepth: DEFAULT_MAX_NESTING_DEPTH,
        ...overrides,
      };
      return { executor: new SubagentExecutor(ctx), manager };
    }

    it('passes parentId: call.id to forkSubagent (Edit B)', async () => {
      const { executor: exec, manager } = makeNestingExecutor2();
      const call = makeCall({ id: 'tool-use-abc123' });

      await exec.execute(call);

      expect(manager.forkSubagent).toHaveBeenCalledWith(
        expect.objectContaining({ parentId: 'tool-use-abc123' }),
      );
    });

    it('depth-1 child executor parentSession.sessionId is backfilled to handle.id after fork (Edit C)', async () => {
      // Arrange: capture the childExecutor passed to the factory, then check
      // its parentSession.sessionId after the fork resolves.
      let capturedChildExecutorCtx: SubagentExecutorContext | undefined;

      const handle = mockHandle();
      (handle as any).id = 'depth-1-handle-id';
      (handle.runToResult as any).mockResolvedValue({
        id: 'depth-1-handle-id',
        status: 'succeeded',
        message: { role: 'assistant', content: 'ok', timestamp: new Date() },
      });

      const manager = {
        forkSubagent: vi.fn().mockResolvedValue(handle),
        teardownAll: vi.fn().mockResolvedValue(undefined),
      };

      const factory = vi.fn().mockImplementation(({ childExecutor }: { childExecutor: SubagentExecutor }) => {
        // Capture the internal ctx via the constructor arg — child executor
        // exposes no public ctx, but we can spy on its execute call to check
        // the parentSession at the moment a depth-2 fork would fire.
        capturedChildExecutorCtx = (childExecutor as any).ctx as SubagentExecutorContext;
        return { name: 'p', query: vi.fn() };
      });

      const exec = new SubagentExecutor({
        subagentManager: manager as any,
        parentSession: {
          sessionId: 'root-session',
          getInputStreamRef: vi.fn(),
          abortSignal: new AbortController().signal,
        },
        defaultConfig: { apiKey: 'k', systemPrompt: 'sp' },
        childProviderFactory: factory,
        depth: 0,
        maxDepth: DEFAULT_MAX_NESTING_DEPTH,
      });

      await exec.execute(makeCall({ id: 'call-xyz' }));

      // After execute resolves, the child executor's parentSession.sessionId
      // must equal the depth-1 handle id (backfilled in Edit C).
      expect(capturedChildExecutorCtx).toBeDefined();
      expect(capturedChildExecutorCtx!.parentSession.sessionId).toBe('depth-1-handle-id');
    });

    // Worktree-cwd propagation through the `agent` tool's recursive nesting.
    //
    // External constraint: a depth-1 subagent calling the `agent` tool spawns
    // depth-2 forks via the per-call `childManager` constructed inside
    // SubagentExecutor.execute(). Without `cwd` on `SubagentExecutorContext`,
    // that childManager was instantiated with no `cwd` — `parentCwd`
    // undefined — and SubagentManager.forkSubagent silently omitted `cwd`
    // from depth-2 child config. The depth-2 child's bash/grep/read_file
    // then resolved against `process.cwd()` (host repo), defeating
    // `afk --worktree` isolation past the first depth.
    //
    // This test pins the two halves of the fix:
    //   (1) the childManager was constructed with `cwd`, so its
    //       `parentCwd` is set (proving depth-2 forks inherit cwd).
    //   (2) the recursive `new SubagentExecutor(...)` received `cwd`, so
    //       depth-2 calls to the `agent` tool keep the chain (depth-3+).
    it('forwards ctx.cwd to childManager and recursive child executor (worktree isolation depth ≥ 2)', async () => {
      let capturedChildExecutorCtx: SubagentExecutorContext | undefined;

      const handle = mockHandle();
      const manager = {
        forkSubagent: vi.fn().mockResolvedValue(handle),
        teardownAll: vi.fn().mockResolvedValue(undefined),
      };

      const factory = vi.fn().mockImplementation(({ childExecutor }: { childExecutor: SubagentExecutor }) => {
        capturedChildExecutorCtx = (childExecutor as any).ctx as SubagentExecutorContext;
        return { name: 'p', query: vi.fn() };
      });

      const exec = new SubagentExecutor({
        subagentManager: manager as any,
        parentSession: {
          sessionId: 'root',
          getInputStreamRef: vi.fn(),
          abortSignal: new AbortController().signal,
        },
        defaultConfig: { apiKey: 'k', systemPrompt: 'sp' },
        childProviderFactory: factory,
        depth: 0,
        maxDepth: DEFAULT_MAX_NESTING_DEPTH,
        cwd: '/tmp/wt/feat-x',
      });

      await exec.execute(makeCall());

      expect(capturedChildExecutorCtx).toBeDefined();
      // (1) childManager (constructed inside execute()) carries the cwd so
      //     its forkSubagent injects cwd into depth-2 child config.
      const childManager = capturedChildExecutorCtx!.subagentManager as unknown as { parentCwd: string | undefined };
      expect(childManager.parentCwd).toBe('/tmp/wt/feat-x');
      // (2) The recursive SubagentExecutor received cwd, so when IT runs
      //     execute() (a depth-2 `agent` call) it will repeat the same
      //     forwarding for the depth-3 childManager — proving the chain
      //     holds for arbitrary depth up to maxDepth.
      expect(capturedChildExecutorCtx!.cwd).toBe('/tmp/wt/feat-x');
    });

    // setCwd re-anchors mid-session (born-named `afk -w` worktree on turn 1):
    //   (1) the root manager (depth-1 forks) is re-anchored via manager.setCwd
    //   (2) the depth-2+ childManager built in execute() uses the new cwd
    it('setCwd re-anchors the root manager and depth-2+ child managers', async () => {
      let capturedChildExecutorCtx: SubagentExecutorContext | undefined;

      const handle = mockHandle();
      const manager = {
        forkSubagent: vi.fn().mockResolvedValue(handle),
        teardownAll: vi.fn().mockResolvedValue(undefined),
        setCwd: vi.fn(),
      };

      const factory = vi.fn().mockImplementation(({ childExecutor }: { childExecutor: SubagentExecutor }) => {
        capturedChildExecutorCtx = (childExecutor as any).ctx as SubagentExecutorContext;
        return { name: 'p', query: vi.fn() };
      });

      const exec = new SubagentExecutor({
        subagentManager: manager as any,
        parentSession: {
          sessionId: 'root',
          getInputStreamRef: vi.fn(),
          abortSignal: new AbortController().signal,
        },
        defaultConfig: { apiKey: 'k', systemPrompt: 'sp' },
        childProviderFactory: factory,
        depth: 0,
        maxDepth: DEFAULT_MAX_NESTING_DEPTH,
        cwd: '/tmp/launch/dir',
      });

      exec.setCwd('/tmp/launch/dir/.afk-worktrees/afk-xyz');

      // (1) depth-1 forks: the root manager was re-anchored.
      expect(manager.setCwd).toHaveBeenCalledWith('/tmp/launch/dir/.afk-worktrees/afk-xyz');

      // (2) depth-2+ forks: the child manager + executor built in execute() use it.
      await exec.execute(makeCall());
      const childManager = capturedChildExecutorCtx!.subagentManager as unknown as { parentCwd: string | undefined };
      expect(childManager.parentCwd).toBe('/tmp/launch/dir/.afk-worktrees/afk-xyz');
      expect(capturedChildExecutorCtx!.cwd).toBe('/tmp/launch/dir/.afk-worktrees/afk-xyz');
    });
  });

  // ISSUE H3: agentType fallback chain — all three legs.
  //
  // Leg (a): custom id_prefix !== 'agent-tool' → agentType === sanitized id_prefix
  // Leg (b): id_prefix === 'agent-tool' + real prompt → first 40 sanitized chars
  // Leg (c): id_prefix === 'agent-tool' + empty/whitespace prompt → literal 'agent'
  //
  // Tests assert against the SANITIZED form from CROSS-REF A:
  //   stripAnsi(...).replace(/[\r\n]+/g, ' ').slice(0, 40).trim() || 'agent'
  describe('agentType fallback chain (issue H3)', () => {
    it('leg (a): custom id_prefix uses the prefix directly as agentType', async () => {
      const handle = mockHandle();
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      await executor.execute(
        makeCall({ input: { prompt: 'some prompt', id_prefix: 'code-review' } }),
      );

      expect(mockSubagentMgr.forkSubagent).toHaveBeenCalledWith(
        expect.objectContaining({ agentType: 'code-review' }),
      );
    });

    it('leg (b): default id_prefix with real prompt uses sanitized first-40-char slice as agentType', async () => {
      // 50-char prompt with an embedded newline in the first 40 chars.
      // Sanitization must: (1) collapse the newline to a space, (2) take the
      // first 40 chars of the sanitized string, (3) trim.
      const prompt = 'Analyse the codebase\nand write a summary for the team';
      const expected = prompt.replace(/[\r\n]+/g, ' ').slice(0, 40).trim();

      const handle = mockHandle();
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      await executor.execute(makeCall({ input: { prompt } }));

      expect(mockSubagentMgr.forkSubagent).toHaveBeenCalledWith(
        expect.objectContaining({ agentType: expected }),
      );
      // Sanity: the rendered label must not contain any raw newline.
      const actualCall = (mockSubagentMgr.forkSubagent as any).mock.calls[0][0];
      expect(actualCall.agentType).not.toMatch(/[\r\n]/);
    });

    it('leg (b) — ANSI escapes in prompt are stripped from agentType', async () => {
      // CROSS-REF A: stripAnsi must remove terminal control codes that an LLM
      // might embed in its prompt to inject into the user's scrollback.
      const prompt = '\x1b[31mAnalyse\x1b[0m the codebase and report back';
      const expected = 'Analyse the codebase and report back'.slice(0, 40).trim();

      const handle = mockHandle();
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      await executor.execute(makeCall({ input: { prompt } }));

      expect(mockSubagentMgr.forkSubagent).toHaveBeenCalledWith(
        expect.objectContaining({ agentType: expected }),
      );
      const actualCall = (mockSubagentMgr.forkSubagent as any).mock.calls[0][0];
      // eslint-disable-next-line no-control-regex
      expect(actualCall.agentType).not.toMatch(/\x1b/);
    });

    it('leg (c): default id_prefix with whitespace-only prompt falls back to literal "agent"', async () => {
      // Whitespace-only prompts: if validation rejects them before reaching
      // the agentType site, that's also acceptable (it's defence in depth).
      // Otherwise the sanitized form collapses to '' and the || 'agent'
      // sentinel must produce 'agent'.
      const prompt = '   \n\t   ';

      const handle = mockHandle();
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      const result = await executor.execute(makeCall({ input: { prompt } }));

      if (result.isError === true) {
        // Validation rejected whitespace-only prompt before agentType derivation
        // — leg (c) is unreachable via the public dispatch path. Accept and
        // document.
        expect(mockSubagentMgr.forkSubagent).not.toHaveBeenCalled();
      } else {
        // Validation passed → agentType must be the 'agent' sentinel.
        expect(mockSubagentMgr.forkSubagent).toHaveBeenCalledWith(
          expect.objectContaining({ agentType: 'agent' }),
        );
      }
    });
  });

  // -----------------------------------------------------------------------
  // mode: 'background'
  //
  // Contract surface tested:
  //   1. Schema validation: unknown mode rejected, default = foreground
  //   2. Missing registry: refuses the call, tears down the handle
  //   3. Happy path: registers job, returns jobId immediately, does NOT
  //      await runToResult
  //   4. AbortSignal on the tool call does NOT propagate to a backgrounded
  //      child (the cancel-on-end-of-turn anti-pattern)
  // -----------------------------------------------------------------------
  describe('background mode', () => {
    // Lazy import to avoid circular-import pain at module load time.
    let BackgroundAgentRegistry: typeof import('../background-registry.js').BackgroundAgentRegistry;

    beforeEach(async () => {
      ({ BackgroundAgentRegistry } = await import('../background-registry.js'));
    });

    /** Build a real handle stub the registry can drive via runInBackground. */
    function bgHandle(id = 'sub-1') {
      let captured: ((r: SubagentResult) => void) | undefined;
      const cancelMock = vi.fn().mockResolvedValue(undefined);
      const teardownMock = vi.fn().mockResolvedValue(undefined);
      return {
        handle: {
          id,
          status: 'idle',
          runInBackground: vi.fn((_p: string, on?: (r: SubagentResult) => void) => {
            captured = on;
          }),
          cancel: cancelMock,
          teardown: teardownMock,
          // Not used by background branch, but typecheck requires them.
          run: vi.fn(),
          runToResult: vi.fn(),
        } as unknown as SubagentHandle,
        fireTerminal: (r: SubagentResult) => captured?.(r),
        cancelMock,
        teardownMock,
      };
    }

    it('rejects "mode: invalid" with a clear error and does not fork', async () => {
      const result = await executor.execute(
        makeCall({ input: { prompt: 'p', mode: 'sideways' } }),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/mode must be "foreground" or "background"/);
      expect(mockSubagentMgr.forkSubagent).not.toHaveBeenCalled();
    });

    it('mode: "background" with no registry: returns error and tears down the orphan handle', async () => {
      const { handle, teardownMock } = bgHandle();
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      const result = await executor.execute(
        makeCall({ input: { prompt: 'p', mode: 'background' } }),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/Background mode is not available/);
      expect(teardownMock).toHaveBeenCalledTimes(1);
    });

    it('mode: "background" with registry: returns jobId immediately, never awaits runToResult', async () => {
      const registry = new BackgroundAgentRegistry({});
      const { handle, fireTerminal } = bgHandle();
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      const ctxWithBg: SubagentExecutorContext = {
        subagentManager: mockSubagentMgr as any,
        parentSession: mockParentSession as any,
        defaultConfig: mockConfig,
        backgroundRegistry: registry,
        depth: 0,
      };
      const bgExecutor = new SubagentExecutor(ctxWithBg);

      // Time the call — must return promptly even though terminal never fires.
      const before = Date.now();
      const result = await bgExecutor.execute(
        makeCall({ input: { prompt: 'long investigation', mode: 'background' } }),
      );
      const elapsed = Date.now() - before;
      expect(elapsed).toBeLessThan(200);

      expect(result.isError).toBeUndefined();
      const payload = JSON.parse(result.content as string);
      expect(payload.status).toBe('running');
      expect(payload.jobId).toMatch(/^bg-/);
      expect(payload.subagentId).toBe('sub-1');
      expect(payload.label).toBe('long investigation');
      expect(payload.message).toMatch(/delivered into this context/);

      // Sanity: the job is observable via the registry; status still running.
      const observed = registry.get(payload.jobId);
      expect(observed?.status).toBe('running');

      // Terminal callback was wired correctly: firing it transitions the
      // registry without touching the executor.
      fireTerminal({
        id: 'sub-1',
        status: 'succeeded' as SubagentResult['status'],
        message: { content: 'final', role: 'assistant' } as any,
      });
      expect(registry.get(payload.jobId)?.status).toBe('completed');
    });

    it('mode: "background" does NOT wire call.signal -> handle.cancel (background outlives the turn)', async () => {
      const registry = new BackgroundAgentRegistry({});
      const { handle, cancelMock } = bgHandle();
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      const bgExecutor = new SubagentExecutor({
        subagentManager: mockSubagentMgr as any,
        parentSession: mockParentSession as any,
        defaultConfig: mockConfig,
        backgroundRegistry: registry,
        depth: 0,
      });

      const ac = new AbortController();
      const result = await bgExecutor.execute(
        makeCall({ input: { prompt: 'p', mode: 'background' }, signal: ac.signal }),
      );
      expect(result.isError).toBeUndefined();

      // Aborting the per-tool-call signal at end-of-turn must NOT cancel a
      // background job — that's the whole point of the mode.
      ac.abort('end of turn');
      await new Promise((r) => setImmediate(r));
      expect(cancelMock).not.toHaveBeenCalled();
    });

    it('mode default is foreground — omitting mode preserves existing behavior', async () => {
      // Reuses the standard mockHandle whose runToResult resolves with
      // "test output" — if the background branch were accidentally
      // taken, the response would be a JSON jobId payload instead.
      const handle = mockHandle();
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);
      const result = await executor.execute(
        makeCall({ input: { prompt: 'do thing' /* no mode */ } }),
      );
      expect(result.isError).toBeUndefined();
      expect(result.content).toBe('test output');
    });

    // Auto-deny: background subagents have no surface to serve interactive
    // elicitations. The executor must pass denyElicitations: true to
    // forkSubagent so the child config gets DENY_ELICITATION installed.
    it('mode: "background" passes denyElicitations: true to forkSubagent', async () => {
      const registry = new BackgroundAgentRegistry({});
      const { handle } = bgHandle();
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      const bgExecutor = new SubagentExecutor({
        subagentManager: mockSubagentMgr as any,
        parentSession: mockParentSession as any,
        defaultConfig: mockConfig,
        backgroundRegistry: registry,
        depth: 0,
      });

      await bgExecutor.execute(
        makeCall({ input: { prompt: 'p', mode: 'background' } }),
      );
      expect(mockSubagentMgr.forkSubagent).toHaveBeenCalledWith(
        expect.objectContaining({ denyElicitations: true }),
      );
    });

    it('mode: "foreground" passes denyElicitations: true to forkSubagent', async () => {
      const handle = mockHandle();
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      await executor.execute(
        makeCall({ input: { prompt: 'p', mode: 'foreground' } }),
      );
      // Foreground forks are non-interactive too: a sub-agent reports
      // Blocked/Asking to its parent rather than eliciting the operator via the
      // process-wide router. Both modes now deny MCP elicitation.
      expect(mockSubagentMgr.forkSubagent).toHaveBeenCalledWith(
        expect.objectContaining({ denyElicitations: true }),
      );
    });

    it('mode omitted (default foreground) passes denyElicitations: true to forkSubagent', async () => {
      const handle = mockHandle();
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      await executor.execute(makeCall({ input: { prompt: 'p' } }));
      expect(mockSubagentMgr.forkSubagent).toHaveBeenCalledWith(
        expect.objectContaining({ denyElicitations: true }),
      );
    });

    // H-2: BackgroundJobCapError teardown path.
    //
    // When the registry is at capacity, register() throws BackgroundJobCapError.
    // The executor must:
    //   (a) catch it, NOT re-throw,
    //   (b) call handle.teardown() to avoid leaking the orphaned fork,
    //   (c) return { isError: true } with the cap-error message.
    it('BackgroundJobCapError: tears down orphan handle and returns isError (H-2)', async () => {
      // Registry at maxConcurrentJobs: 1, with one job already running.
      const registry = new BackgroundAgentRegistry({ maxConcurrentJobs: 1 });
      const occupant = bgHandle('occupant');
      // Fill the cap: register a first job manually via the registry directly.
      registry.register({
        handle: occupant.handle,
        prompt: 'occupant job',
        model: 'sonnet',
      });
      // Now the registry is full (1/1 running).

      // Second fork attempt from the executor should hit the cap.
      const second = bgHandle('second');
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(second.handle);

      const bgExecutor = new SubagentExecutor({
        subagentManager: mockSubagentMgr as any,
        parentSession: mockParentSession as any,
        defaultConfig: mockConfig,
        backgroundRegistry: registry,
        depth: 0,
      });

      const result = await bgExecutor.execute(
        makeCall({ input: { prompt: 'second job', mode: 'background' } }),
      );

      // (a) executor must NOT throw — it must return a ToolResult
      // (b) executor must have called teardown() on the second handle
      expect(second.teardownMock).toHaveBeenCalledTimes(1);
      // (c) result must be an error carrying the cap message
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/Background job cap reached/);
    });
  });

  // -------------------------------------------------------------------------
  // fork-throws telemetry (A1: bgsub-completion-telemetry)
  //
  // When forkSubagent() throws before reaching the background/foreground
  // dispatch branch, the catch block must emit subagent.failed so the
  // orphan dispatched→no-completion pattern is visible at the catch site.
  // -------------------------------------------------------------------------
  describe('fork-throws telemetry (A1)', () => {
    beforeEach(() => {
      appendRoutingDecision.mockClear();
    });

    it('emits subagent.failed when forkSubagent throws', async () => {
      mockSubagentMgr.forkSubagent = vi.fn().mockRejectedValue(new Error('network timeout'));

      const result = await executor.execute(makeCall({ input: { prompt: 'investigate', id_prefix: 'my-prefix' } }));

      // The call still returns an error result (no re-throw).
      expect(result.isError).toBe(true);
      expect(result.content).toContain('network timeout');

      // appendRoutingDecision must have been called with subagent.failed.
      const failedCalls = appendRoutingDecision.mock.calls.filter(
        (c) => (c[0] as Record<string, unknown>)?.['event'] === 'subagent.failed',
      );
      expect(failedCalls).toHaveLength(1);
      const entry = failedCalls[0]![0] as Record<string, unknown>;
      expect(entry['event']).toBe('subagent.failed');
      expect(entry['subagent_id']).toBe('unknown');
      expect(entry['id_prefix']).toBe('my-prefix');
      expect(entry['parent_session_id']).toBe('parent-session-id');
      expect(entry['status']).toBe('failed');
      expect(entry['error_message']).toContain('network timeout');
    });

    it('does NOT emit subagent.failed on the happy fork path', async () => {
      const handle = mockHandle();
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      await executor.execute(makeCall());

      const failedCalls = appendRoutingDecision.mock.calls.filter(
        (c) => (c[0] as Record<string, unknown>)?.['event'] === 'subagent.failed',
      );
      expect(failedCalls).toHaveLength(0);
    });

    it('subagent.failed error_message is truncated for large error strings', async () => {
      const huge = 'X'.repeat(5000);
      mockSubagentMgr.forkSubagent = vi.fn().mockRejectedValue(new Error(huge));

      await executor.execute(makeCall());

      const failedCalls = appendRoutingDecision.mock.calls.filter(
        (c) => (c[0] as Record<string, unknown>)?.['event'] === 'subagent.failed',
      );
      expect(failedCalls).toHaveLength(1);
      const entry = failedCalls[0]![0] as Record<string, unknown>;
      // truncate() caps at 240 + ellipsis
      expect((entry['error_message'] as string).length).toBeLessThanOrEqual(241);
    });
  });

  // -------------------------------------------------------------------------
  // Promotion: Ctrl+B backgrounds a *running foreground* subagent.
  //
  // The foreground await is raced against a promotion signal exposed through
  // the narrow SubagentControl seam. When fired, the in-flight handle is
  // handed to the registry via adoptRunning() (NOT register/runInBackground,
  // which would re-enter run() and throw "already running"), the parent turn
  // is unblocked with a synthetic "running" pointer, and the handle is NOT
  // torn down — the registry now owns its lifetime.
  // -------------------------------------------------------------------------
  describe('promotion (foreground → background via SubagentControl)', () => {
    let BackgroundAgentRegistry: typeof import('../background-registry.js').BackgroundAgentRegistry;

    beforeEach(async () => {
      ({ BackgroundAgentRegistry } = await import('../background-registry.js'));
    });

    const tick = () => new Promise((r) => setImmediate(r));

    function promotableExecutor(
      registry: InstanceType<typeof BackgroundAgentRegistry>,
    ): SubagentExecutor {
      return new SubagentExecutor({
        subagentManager: mockSubagentMgr as any,
        parentSession: mockParentSession as any,
        defaultConfig: mockConfig,
        backgroundRegistry: registry,
        depth: 0,
      });
    }

    it('hasPromotableForeground is false with no registry wired', () => {
      // `executor` (default ctx) has no backgroundRegistry.
      expect(executor.hasPromotableForeground()).toBe(false);
    });

    it('hasPromotableForeground is false when nothing is in flight', () => {
      const registry = new BackgroundAgentRegistry({});
      expect(promotableExecutor(registry).hasPromotableForeground()).toBe(false);
    });

    it('promotes a running foreground subagent: running pointer, no teardown, job observable', async () => {
      const registry = new BackgroundAgentRegistry({});
      const { handle, resolveRun } = hangingHandle();
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);
      const exec = promotableExecutor(registry);

      // Start the foreground run but do NOT await — it hangs until resolveRun.
      const execPromise = exec.execute(makeCall({ input: { prompt: 'deep investigation' } }));
      await tick(); // let execute() fork + register its promotion trigger

      expect(exec.hasPromotableForeground()).toBe(true);

      const promoted = await exec.promoteActiveForeground();
      expect(promoted).toHaveLength(1);
      expect(promoted[0]!.jobId).toMatch(/^bg-/);
      expect(promoted[0]!.label).toBe('deep investigation');

      // The parent turn is unblocked with the synthetic running pointer.
      const result = await execPromise;
      expect(result.isError).toBeUndefined();
      const payload = JSON.parse(result.content as string);
      expect(payload.status).toBe('running');
      expect(payload.jobId).toBe(promoted[0]!.jobId);
      expect(payload.message).toMatch(/backgrounded by user/i);

      // The promoted handle was NOT torn down or cancelled — the registry owns it.
      expect(handle.teardown).not.toHaveBeenCalled();
      expect(handle.cancel).not.toHaveBeenCalled();

      // Observable as a running registry job; the trigger is cleared.
      expect(registry.get(payload.jobId)?.status).toBe('running');
      expect(exec.hasPromotableForeground()).toBe(false);

      // Resolving the in-flight run drives the adopted job to terminal.
      resolveRun({
        id: 'test-handle',
        status: 'succeeded' as SubagentResult['status'],
        message: { role: 'assistant', content: 'done', timestamp: new Date() } as any,
      });
      await tick();
      expect(registry.get(payload.jobId)?.status).toBe('completed');
    });

    it('promote-all: two concurrent in-flight subagents are both promoted', async () => {
      const registry = new BackgroundAgentRegistry({});
      const a = hangingHandle();
      const b = hangingHandle();
      (a.handle as any).id = 'sub-a';
      (b.handle as any).id = 'sub-b';
      const forks = [a.handle, b.handle];
      let i = 0;
      mockSubagentMgr.forkSubagent = vi.fn().mockImplementation(() => Promise.resolve(forks[i++]));
      const exec = promotableExecutor(registry);

      const p1 = exec.execute(makeCall({ id: 'call-a', input: { prompt: 'first' } }));
      const p2 = exec.execute(makeCall({ id: 'call-b', input: { prompt: 'second' } }));
      await tick();

      expect(exec.hasPromotableForeground()).toBe(true);
      const promoted = await exec.promoteActiveForeground();
      expect(promoted).toHaveLength(2);

      const r1 = JSON.parse((await p1).content as string);
      const r2 = JSON.parse((await p2).content as string);
      expect(r1.status).toBe('running');
      expect(r2.status).toBe('running');
      expect(new Set([r1.subagentId, r2.subagentId])).toEqual(new Set(['sub-a', 'sub-b']));
    });

    it('race: run completes before promotion — normal result, nothing promoted, torn down', async () => {
      const registry = new BackgroundAgentRegistry({});
      // Non-hanging handle: runToResult resolves immediately with output.
      const handle = mockHandle();
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);
      const exec = promotableExecutor(registry);

      const result = await exec.execute(makeCall({ input: { prompt: 'quick' } }));
      expect(result.content).toBe('test output');
      expect(result.isError).toBeUndefined();

      // Nothing left to promote, and the (non-promoted) handle was torn down.
      expect(exec.hasPromotableForeground()).toBe(false);
      expect(await exec.promoteActiveForeground()).toEqual([]);
      expect(handle.teardown).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // In-turn SubagentStop injectContext delivery.
  //
  // A foreground `agent` fork whose SubagentStop returns injectContext (e.g.
  // the shadow-verify nudge) must deliver that note in the SAME turn — appended
  // to the returned tool_result — and NOT via the parent's deferred input-stream
  // queue. The executor coordinates this by calling
  // `teardown({ deferInjectContextToCaller: true })` (which suppresses the queue
  // push and records the note) and then appending `getLastStopInjectContext()`
  // to the completion ToolResult in its finally.
  // -------------------------------------------------------------------------
  describe('in-turn SubagentStop injectContext delivery', () => {
    it('appends the injectContext to the returned tool_result (success path)', async () => {
      const nudge = '[framework-generated context: shadow-verify nudge]';
      const handle = mockHandle({
        message: { role: 'assistant', content: 'subagent findings', timestamp: new Date() },
        injectContext: nudge,
      });
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      const result = await executor.execute(makeCall());

      expect(result.isError).toBeUndefined();
      expect(result.content).toBe(`subagent findings\n\n${nudge}`);
    });

    it('calls teardown with deferInjectContextToCaller: true (suppresses queue push)', async () => {
      const handle = mockHandle({ injectContext: 'note' });
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      await executor.execute(makeCall());

      // Deliver-once: the executor must ask the handle to DEFER queue delivery
      // to the caller, so the note rides the tool_result exclusively.
      expect(handle.teardown).toHaveBeenCalledWith({ deferInjectContextToCaller: true });
    });

    it('does NOT push to the parent input-stream / queue when delivering in-turn (deliver-once)', async () => {
      // Full deliver-once assertion at the executor seam: with a real-shaped
      // parent input-stream ref, neither channel is touched — the executor
      // reads the note off the handle (deferred) instead.
      const nudge = 'inline nudge body';
      const queueSpy = vi.fn();
      const pushSpy = vi.fn();
      const handle = mockHandle({
        message: { role: 'assistant', content: 'body', timestamp: new Date() },
        injectContext: nudge,
      });
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      const exec = new SubagentExecutor({
        subagentManager: mockSubagentMgr as any,
        parentSession: {
          sessionId: 'parent',
          getInputStreamRef: () => ({ pushUserMessage: pushSpy, queueFrameworkContext: queueSpy }),
          abortSignal: new AbortController().signal,
        } as any,
        defaultConfig: mockConfig,
        depth: 0,
      });

      const result = await exec.execute(makeCall());

      expect(result.content).toBe(`body\n\n${nudge}`);
      // The mock handle does not fire the real SubagentStop → queue path, but
      // the executor must never itself push to either channel for this path.
      expect(queueSpy).not.toHaveBeenCalled();
      expect(pushSpy).not.toHaveBeenCalled();
    });

    it('leaves content unchanged when no injectContext is produced (no stray separators)', async () => {
      const handle = mockHandle({
        message: { role: 'assistant', content: 'plain body', timestamp: new Date() },
        // no injectContext → getLastStopInjectContext returns undefined
      });
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      const result = await executor.execute(makeCall());

      expect(result.content).toBe('plain body');
      expect(result.content).not.toContain('\n\n');
    });

    it('does not append when getLastStopInjectContext returns empty string', async () => {
      const handle = mockHandle({
        message: { role: 'assistant', content: 'body', timestamp: new Date() },
        injectContext: '',
      });
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      const result = await executor.execute(makeCall());

      expect(result.content).toBe('body');
    });

    it('appends the injectContext to the structured failure payload (failure path)', async () => {
      const nudge = 'verify: this failure';
      const handle = mockHandle({ status: 'failed', injectContext: nudge });
      (handle as any).id = 'child-fail-inject';
      (handle.runToResult as any).mockResolvedValue({
        id: 'child-fail-inject',
        status: 'failed',
        error: new Error('kaboom'),
        message: undefined,
      });
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      const result = await executor.execute(makeCall());

      expect(result.isError).toBe(true);
      // The JSON payload is followed by the appended nudge, separated by \n\n.
      // The JSON prefix must still parse on its own.
      const [jsonPart, ...rest] = result.content.split('\n\n');
      expect(rest.join('\n\n')).toBe(nudge);
      const payload = JSON.parse(jsonPart!);
      expect(payload.status).toBe('failed');
      expect(payload.error).toBe('kaboom');
    });
  });

  // ── Cancellation (soft-stop via SubagentControl) ──────────────────────────
  // Unlike promotion, cancellation must work with NO background registry wired:
  // it is how ESC / Ctrl+C unblocks a parent turn suspended on a subagent
  // `await` (the "stuck mid-subagent, have to fork the session" bug). These
  // tests use the default `executor`, which has no backgroundRegistry.
  describe('cancellation (soft-stop via SubagentControl)', () => {
    const tick = () => new Promise((r) => setImmediate(r));

    it('hasActiveForeground is false when nothing is in flight', () => {
      expect(executor.hasActiveForeground()).toBe(false);
    });

    it('cancelActiveForeground is a no-op returning 0 when nothing is in flight', async () => {
      expect(await executor.cancelActiveForeground()).toBe(0);
    });

    it('tracks an in-flight foreground subagent and cancels it WITHOUT a registry', async () => {
      const { handle, resolveRun } = hangingHandle();
      mockSubagentMgr.forkSubagent = vi.fn().mockResolvedValue(handle);

      // Start the foreground run but do NOT await — it hangs until resolveRun.
      const execPromise = executor.execute(makeCall({ input: { prompt: 'deep investigation' } }));
      await tick(); // let execute() fork + register the handle

      expect(executor.hasActiveForeground()).toBe(true);
      // Cancellation is available even though promotion is NOT (no registry).
      expect(executor.hasPromotableForeground()).toBe(false);

      const cancelled = await executor.cancelActiveForeground();
      expect(cancelled).toBe(1);
      expect(handle.cancel).toHaveBeenCalledTimes(1);

      // In production handle.cancel() resolves runToResult; the mock's cancel is
      // inert, so simulate that resolution to unblock execute() and let its
      // finally clear the tracking map.
      resolveRun({
        id: 'test-handle',
        status: 'cancelled' as SubagentResult['status'],
        error: new Error('cancelled'),
      } as SubagentResult);
      await execPromise.catch(() => { /* failure payload path returns, no throw */ });
      expect(executor.hasActiveForeground()).toBe(false);
    });

    it('cancel-all: cancels every in-flight foreground subagent and returns the count', async () => {
      const a = hangingHandle();
      const b = hangingHandle();
      (a.handle as any).id = 'sub-a';
      (b.handle as any).id = 'sub-b';
      const forks = [a.handle, b.handle];
      let i = 0;
      mockSubagentMgr.forkSubagent = vi.fn().mockImplementation(() => Promise.resolve(forks[i++]));

      const p1 = executor.execute(makeCall({ id: 'call-a', input: { prompt: 'first' } }));
      const p2 = executor.execute(makeCall({ id: 'call-b', input: { prompt: 'second' } }));
      await tick();

      expect(executor.hasActiveForeground()).toBe(true);
      expect(await executor.cancelActiveForeground()).toBe(2);
      expect(a.handle.cancel).toHaveBeenCalledTimes(1);
      expect(b.handle.cancel).toHaveBeenCalledTimes(1);

      a.resolveRun({ id: 'sub-a', status: 'cancelled' as SubagentResult['status'], error: new Error('x') } as SubagentResult);
      b.resolveRun({ id: 'sub-b', status: 'cancelled' as SubagentResult['status'], error: new Error('x') } as SubagentResult);
      await Promise.allSettled([p1, p2]);
      expect(executor.hasActiveForeground()).toBe(false);
    });
  });
});
