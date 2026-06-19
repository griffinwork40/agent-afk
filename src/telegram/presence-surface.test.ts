/**
 * Telegram presence-surface contract.
 *
 * Both Telegram session branches in `telegram.ts main()` — the Anthropic-direct
 * `directProvider` and the OpenAI-compatible `codexProvider` — construct their
 * provider with `surface: 'telegram'`. That surface tag is what each provider
 * stamps onto the top-level presence file it writes to
 * `$AFK_HOME/state/presence/<id>.json` (see `writePresenceFile` calls in
 * `anthropic-direct/index.ts` + `openai-compatible/index.ts`). `/watch` reads
 * that field to tell Telegram sessions apart from CLI sessions.
 *
 * The bug this guards: the provider `surface` defaults to `'cli'`, so when the
 * Telegram branches omit the tag, every Telegram session's presence file is
 * mis-labeled `'cli'` and `/watch` mis-classifies it.
 *
 * The literal `createSession` closure in `telegram.ts main()` cannot be reached
 * from a test (see `telegram/construct-session.ts` + `telegram/hook-wiring.test.ts`),
 * so — exactly as hook-wiring.test.ts does — this pins the provider-level
 * CONTRACT both branches depend on: a provider built with `surface: X` must
 * write its presence file tagged `X`, and the default (surface omitted) must
 * stay `'cli'` so CLI/daemon behavior is unchanged. A regression that drops the
 * Telegram tag, or that breaks surface→presence threading in either provider,
 * trips here.
 *
 * Mechanism: the presence write is a fire-and-forget call made *synchronously*
 * inside `provider.query()` (before any streaming), so the test calls `query()`
 * once, never iterates it, waits for the async file write, and asserts on the
 * real presence file. No SDK mock is needed — the Anthropic client is built
 * lazily and never used because the query is not iterated.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  AnthropicDirectProvider,
  OpenAICompatibleProvider,
} from '../agent/providers/index.js';
import { readPresenceFiles } from '../agent/awareness/presence.js';
import type {
  ModelProvider,
  ProviderQuery,
  ProviderUserTurn,
} from '../agent/provider.js';
import type { AgentConfig } from '../agent/types/config-types.js';

let tmpHome: string;
let savedHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'afk-tg-presence-'));
  savedHome = process.env['AFK_HOME'];
  process.env['AFK_HOME'] = tmpHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = savedHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

/**
 * A prompt that yields nothing. The query is never iterated (the presence write
 * fires synchronously during `query()` before the first user turn is pulled),
 * so this just needs to be a valid `AsyncIterable<ProviderUserTurn>`.
 */
async function* emptyPrompt(): AsyncIterable<ProviderUserTurn> {
  // intentionally empty — see docstring
}

/** Poll the presence dir until the record for `sessionId` appears, else undefined. */
async function waitForPresenceSurface(sessionId: string): Promise<string | undefined> {
  for (let i = 0; i < 100; i++) {
    const records = await readPresenceFiles();
    const rec = records.find((r) => r.sessionId === sessionId);
    if (rec) return rec.surface;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return undefined;
}

/**
 * Drive one `query()` just far enough to trigger the (top-level) presence write,
 * then best-effort close. `query()` runs synchronously through the presence
 * write before it returns OR throws (e.g. the OpenAI builder validating creds),
 * so any thrown error is swallowed — the presence file is already scheduled.
 */
function triggerPresence(provider: ModelProvider, config: AgentConfig): void {
  let query: ProviderQuery | undefined;
  try {
    query = provider.query({ prompt: emptyPrompt(), config });
  } catch {
    // presence write already scheduled before any post-write throw
  }
  if (query !== undefined) {
    void Promise.resolve(query.close()).catch(() => {
      // best-effort cleanup
    });
  }
}

interface Branch {
  name: string;
  makeProvider: (surface?: string) => ModelProvider;
  config: (sessionId: string) => AgentConfig;
}

// One entry per Telegram session branch. `surface` is threaded through the
// constructor exactly as telegram.ts does it; `makeProvider(undefined)`
// exercises the constructor default.
const branches: Branch[] = [
  {
    name: 'Anthropic-direct (Telegram directProvider branch)',
    makeProvider: (surface) =>
      new AnthropicDirectProvider(surface !== undefined ? { surface } : {}),
    config: (sessionId) => ({
      model: 'claude-sonnet-4-5-20250929',
      apiKey: 'sk-ant-oat01-test',
      sessionId,
    }),
  },
  {
    name: 'OpenAI-compatible (Telegram codexProvider branch)',
    makeProvider: (surface) =>
      new OpenAICompatibleProvider(surface !== undefined ? { surface } : {}),
    config: (sessionId) => ({
      model: 'gpt-5.1',
      apiKey: 'test-openai-key',
      sessionId,
    }),
  },
];

describe('Telegram presence surface contract', () => {
  for (const branch of branches) {
    describe(branch.name, () => {
      it('stamps presence surface "telegram" when constructed with surface:telegram (the fix)', async () => {
        const sessionId = 'tg-surface-telegram';
        triggerPresence(branch.makeProvider('telegram'), branch.config(sessionId));
        // The exact bug: this would be 'cli' if the Telegram branch omitted the tag.
        expect(await waitForPresenceSurface(sessionId)).toBe('telegram');
      });

      it('defaults presence surface to "cli" when surface is omitted (CLI behavior unchanged)', async () => {
        const sessionId = 'cli-surface-default';
        triggerPresence(branch.makeProvider(), branch.config(sessionId));
        expect(await waitForPresenceSurface(sessionId)).toBe('cli');
      });

      it('stamps presence surface "daemon" when constructed with surface:daemon (daemon behavior unchanged)', async () => {
        const sessionId = 'daemon-surface';
        triggerPresence(branch.makeProvider('daemon'), branch.config(sessionId));
        expect(await waitForPresenceSurface(sessionId)).toBe('daemon');
      });
    });
  }
});
