/**
 * #4882: subagent_lifecycle.started carries the provider-aware credential id
 * of the child's model.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { emitForkStarted } from './fork-lifecycle.js';
import { InMemoryTraceWriter } from '../trace/writer.js';
import type { AgentConfig } from '../types.js';

vi.mock('../auth/keychain.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/keychain.js')>();
  return { ...actual, loadClaudeCodeOauthToken: vi.fn(() => 'sk-ant-oat01-keychain') };
});

async function startedPayload(model: string): Promise<Record<string, unknown>> {
  const w = new InMemoryTraceWriter();
  emitForkStarted({
    effectiveTraceWriter: w, id: 'child-1', parentSessionId: 'p', rootId: 'r',
    effectiveChildModel: model, childConfig: { model } as AgentConfig,
    promptHead: undefined, effectiveAgentType: undefined, effectiveResolvedAgentType: undefined,
  });
  await new Promise((r) => setTimeout(r, 0));
  const ev = w.events.find((e) => e.kind === 'subagent_lifecycle');
  return ev!.payload as unknown as Record<string, unknown>;
}

describe('emitForkStarted credentialSource', () => {
  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('CODEX_API_KEY', '');
    vi.stubEnv('AFK_PROVIDER', '');
    vi.stubEnv('AFK_OPENAI_BASE_URL', '');
    vi.stubEnv('AFK_LOCAL_BASE_URL', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('Anthropic child records the Anthropic tier', async () => {
    expect((await startedPayload('claude-sonnet-4-6'))['credentialSource']).toBe('claude-code-keychain');
  });

  it('OpenAI child records an openai: id, never the Anthropic tier', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-proj-zzzz');
    const p = await startedPayload('gpt-5');
    expect(p['credentialSource']).toBe('openai:env');
    expect(JSON.stringify(p)).not.toContain('zzzz');
  });

  it('no usable credential omits the field', async () => {
    // xAI: hermetic (env + the AFK_HOME-redirected token store; no ~/.codex read).
    vi.stubEnv('XAI_API_KEY', '');
    const p = await startedPayload('grok-4');
    expect('credentialSource' in p).toBe(false);
  });
});
