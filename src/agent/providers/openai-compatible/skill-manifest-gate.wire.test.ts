/**
 * Call-site tests for the skills-manifest grant gate on the OpenAI wire.
 *
 * Runs a real `OpenAICompatibleProvider.query()` against a scripted client
 * (same harness shape as `slot-tool-deny.wire.test.ts`) and inspects the
 * system message actually sent. This covers the call site in `index.ts`,
 * which assembler-level tests with a hand-set flag cannot.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type OpenAI from 'openai';
import type { ProviderUserTurn } from '../../provider.js';
import type { AgentConfig } from '../../types/config-types.js';
import type { ToolPermissionConfig } from '../../tools/permissions.js';
import type { SkillExecutor } from '../../tools/skill-executor.js';
import { __setOpenAIClientFactory, type OpenAIClientFactory } from './query.js';
import type { OpenAIChunk } from './translate.js';
import { OpenAICompatibleProvider } from './index.js';

// The real manifest header (skill-bridge.ts). No mock: bundled skills ship in
// the repo, so a skill-granted session always has a non-empty manifest, and
// asserting on the real header proves the text actually reaches the wire.
const MANIFEST = 'Available skills (invoke via the `skill` tool)';

async function* oneTurn(content: string): AsyncIterable<ProviderUserTurn> { yield { content }; }
const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
const done: OpenAIChunk[] = [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage } as OpenAIChunk];

type WireCall = { messages: Array<{ role: string; content?: unknown }> };

function scripted(): { factory: OpenAIClientFactory; calls: WireCall[] } {
  const calls: WireCall[] = [];
  const factory: OpenAIClientFactory = () => ({
    chat: { completions: { create: async (args: never) => {
      calls.push(args);
      return (async function* () { for (const c of done) yield c; })();
    } } },
  }) as unknown as OpenAI;
  return { factory, calls };
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'afk-skill-manifest-wire-'));
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('AFK_HOME', join(root, 'home'));
  vi.spyOn(process, 'cwd').mockReturnValue(join(root, 'project'));
});
afterEach(() => { __setOpenAIClientFactory(null); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

/** Everything the model was told outside the conversation turns. */
async function systemText(permissions: ToolPermissionConfig | undefined, withExecutor = true): Promise<string> {
  const s = scripted();
  __setOpenAIClientFactory(s.factory);
  const provider = new OpenAICompatibleProvider({
    ...(withExecutor ? { skillExecutor: { getManifestScope: () => ({}) } as unknown as SkillExecutor } : {}),
    ...(permissions !== undefined ? { permissions } : {}),
  });
  const q = provider.query({ prompt: oneTurn('go'), config: { model: 'gpt-4o-mini', apiKey: 'sk-test' } as AgentConfig });
  for await (const ev of q) void ev;
  expect(s.calls.length).toBeGreaterThan(0);
  const sys = s.calls[0]!.messages.filter((m) => m.role === 'system' || m.role === 'developer');
  expect(sys.length).toBeGreaterThan(0);
  return JSON.stringify(sys);
}

describe('openai-compatible skills-manifest grant gate (wire)', () => {
  it('omits the manifest when the allowlist does not contain skill', async () => {
    expect(await systemText({ allowedTools: ['read_file', 'grep', 'glob'] })).not.toContain(MANIFEST);
  });

  it('omits the manifest when skill is operator-denied', async () => {
    expect(await systemText({ deniedTools: ['skill'] })).not.toContain(MANIFEST);
  });

  it('keeps the manifest when the allowlist contains skill', async () => {
    expect(await systemText({ allowedTools: ['read_file', 'skill'] })).toContain(MANIFEST);
  });

  it('keeps the manifest when no permissions are configured (main-session shape)', async () => {
    expect(await systemText(undefined)).toContain(MANIFEST);
  });

  it('AFK_SKILLS_MANIFEST_ALWAYS=1 restores the manifest for a skill-denied session', async () => {
    vi.stubEnv('AFK_SKILLS_MANIFEST_ALWAYS', '1');
    expect(await systemText({ allowedTools: ['read_file', 'grep', 'glob'] })).toContain(MANIFEST);
  });

  it('has no manifest without a skill executor', async () => {
    expect(await systemText(undefined, false)).not.toContain(MANIFEST);
  });
});
