/**
 * Call-site tests for the skills-manifest grant gate on the Anthropic path.
 *
 * Drives `setUpQuerySession` through a real `AnthropicDirectProvider` with
 * real permissions (same approach as `agent-type-gate.test.ts`), so the test
 * covers the whole chain: provider permissions -> `grantsTool('skill')` ->
 * `skillManifestGranted` -> `assembleQueryPrompt` -> assembled prompt text.
 * Assembler-level tests with a hand-set flag cannot catch a call site that
 * stops passing the decision; these can.
 *
 * @module agent/providers/anthropic-direct/skill-manifest-gate.test
 */

import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../../types/config-types.js';
import type { ToolPermissionConfig } from '../../tools/permissions.js';
import type { SkillExecutor } from '../../tools/skill-executor.js';
import type { ProviderQueryContext } from './provider-context.js';
import { AnthropicDirectProvider } from './index.js';
import { setUpQuerySession } from './provider-query-setup.js';

const MANIFEST = 'SKILLS_MANIFEST_SENTINEL';

// The real builder scans skill directories on disk. Replace only that one
// export so the test asserts on a fixed marker instead of the local install.
vi.mock('../../tools/skill-bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../tools/skill-bridge.js')>()),
  buildSkillManifest: () => MANIFEST,
}));

const BASE_CONFIG: AgentConfig = {
  model: 'claude-sonnet-4-5',
  apiKey: 'sk-ant-test-gate',
  depth: 1,
  parentSessionId: 'test-parent',
  cwd: '/test',
};

function makePrompt() {
  return (async function* () { yield { content: 'probe' }; })();
}

/** Minimal executor: the gate only needs it to exist and expose a scope. */
function makeSkillExecutorStub(): SkillExecutor {
  return { getManifestScope: () => ({}) } as unknown as SkillExecutor;
}

const providers: AnthropicDirectProvider[] = [];

afterEach(() => {
  for (const p of providers.splice(0)) p.close();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function setup(opts: { skillExecutor?: boolean; permissions?: ToolPermissionConfig }): {
  ctx: ProviderQueryContext;
  prompt: () => string;
} {
  const provider = new AnthropicDirectProvider({
    clientFactory: () => ({} as Anthropic),
    ...(opts.skillExecutor === false ? {} : { skillExecutor: makeSkillExecutorStub() }),
    ...(opts.permissions !== undefined ? { permissions: opts.permissions } : {}),
  });
  providers.push(provider);
  const ctx = (provider as unknown as { queryContext(): ProviderQueryContext }).queryContext();
  return {
    ctx,
    prompt: () =>
      setUpQuerySession(
        ctx,
        { prompt: makePrompt(), config: BASE_CONFIG },
        'anthropic-direct',
        'claude-sonnet-4-5',
      ).toolSystemAppend,
  };
}

describe('anthropic-direct skills-manifest grant gate', () => {
  it('omits the manifest when the allowlist does not contain skill', () => {
    // The research-agent / git-investigator shape: executor wired, skill not allowed.
    const { prompt } = setup({ permissions: { allowedTools: ['read_file', 'grep', 'glob'] } });
    expect(prompt()).not.toContain(MANIFEST);
  });

  it('omits the manifest when skill is operator-denied', () => {
    const { prompt } = setup({ permissions: { deniedTools: ['skill'] } });
    expect(prompt()).not.toContain(MANIFEST);
  });

  it('keeps the manifest when the allowlist contains skill', () => {
    const { prompt } = setup({ permissions: { allowedTools: ['read_file', 'skill'] } });
    expect(prompt()).toContain(MANIFEST);
  });

  it('keeps the manifest when no permissions are configured (main-session shape)', () => {
    const { prompt } = setup({});
    expect(prompt()).toContain(MANIFEST);
  });

  it('keeps the manifest when the grant callback is absent (deliberately not fail-closed)', () => {
    // Unlike the agent-type listing gate, a missing callback preserves the
    // pre-gate behaviour for embedders that never wired permissions.
    const { ctx, prompt } = setup({ permissions: { allowedTools: ['read_file'] } });
    (ctx as Record<string, unknown>)['grantsTool'] = undefined;
    expect(prompt()).toContain(MANIFEST);
  });

  it('AFK_SKILLS_MANIFEST_ALWAYS=1 restores the manifest for a skill-denied session', () => {
    vi.stubEnv('AFK_SKILLS_MANIFEST_ALWAYS', '1');
    const { prompt } = setup({ permissions: { allowedTools: ['read_file', 'grep', 'glob'] } });
    expect(prompt()).toContain(MANIFEST);
  });

  it('has no manifest without a skill executor, whatever the grant says', () => {
    const { prompt } = setup({ skillExecutor: false });
    expect(prompt()).not.toContain(MANIFEST);
  });
});
