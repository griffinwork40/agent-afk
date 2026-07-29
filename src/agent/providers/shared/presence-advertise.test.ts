/**
 * End-to-end presence ADVERTISEMENT behavior, per provider.
 *
 * `presence-surface.test.ts` did not catch the fresh-session gap because every
 * config it builds passes an explicit `sessionId` — it only ever exercised the
 * resumed shape. The cases here deliberately omit `sessionId`, which is the real
 * shape of a fresh REPL session (see `cli/commands/interactive/bootstrap.ts`,
 * where `sessionId` arrives only via `...deps.resumeConfig`).
 *
 * Harness note: the presence write is fire-and-forget but scheduled
 * *synchronously* inside `provider.query()`, before any streaming — so these
 * tests call `query()` once, never iterate it, and assert on the real presence
 * file under a temp `AFK_HOME`. No SDK mock is needed because the client is
 * built lazily and never used. Same approach as `presence-surface.test.ts`.
 *
 * Resolver-level cases live in `presence-lifecycle.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  AnthropicDirectProvider,
  OpenAICompatibleProvider,
} from '../index.js';
import { readPresenceFiles, type PresenceFileInfo } from '../../awareness/presence.js';
import type { ModelProvider, ProviderQuery, ProviderUserTurn } from '../../provider.js';
import type { AgentConfig } from '../../types/config-types.js';

// ---------------------------------------------------------------------------
// End-to-end: a fresh session (NO config.sessionId) must advertise presence.
// ---------------------------------------------------------------------------

let tmpHome: string;
let savedHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'afk-presence-fresh-'));
  savedHome = process.env['AFK_HOME'];
  process.env['AFK_HOME'] = tmpHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = savedHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

async function* emptyPrompt(): AsyncIterable<ProviderUserTurn> {
  // never iterated — the presence write is scheduled synchronously in query()
}

/** Drive query() far enough to schedule the presence write, then best-effort close. */
function triggerPresence(provider: ModelProvider, config: AgentConfig): void {
  let query: ProviderQuery | undefined;
  try {
    query = provider.query({ prompt: emptyPrompt(), config });
  } catch {
    // A post-write throw (e.g. the OpenAI builder validating creds) is fine —
    // the presence write is already scheduled.
  }
  if (query !== undefined) {
    void Promise.resolve(query.close()).catch(() => undefined);
  }
}

/** Poll until any presence record appears, else undefined. */
async function waitForAnyPresence(): Promise<PresenceFileInfo | undefined> {
  for (let i = 0; i < 100; i++) {
    const records = await readPresenceFiles();
    if (records[0] !== undefined) return records[0];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return undefined;
}

interface Branch {
  name: string;
  makeProvider: () => ModelProvider;
  /** Same provider, constructed as a non-CLI surface (daemon/telegram host). */
  makeProviderOnSurface: (surface: string) => ModelProvider;
  /** A fresh-session config — deliberately NO sessionId, as a new REPL builds. */
  freshConfig: () => AgentConfig;
  /** A fork config — must NOT advertise presence. */
  forkConfig: () => AgentConfig;
}

const branches: Branch[] = [
  {
    name: 'anthropic-direct',
    makeProvider: () => new AnthropicDirectProvider({}),
    makeProviderOnSurface: (surface: string) => new AnthropicDirectProvider({ surface }),
    freshConfig: () => ({ model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test' }),
    forkConfig: () => ({
      model: 'claude-sonnet-5',
      apiKey: 'sk-ant-oat01-test',
      depth: 1,
      parentSessionId: 'parent-1',
    }),
  },
  {
    name: 'openai-compatible',
    makeProvider: () => new OpenAICompatibleProvider({}),
    makeProviderOnSurface: (surface: string) => new OpenAICompatibleProvider({ surface }),
    freshConfig: () => ({ model: 'gpt-5.1', apiKey: 'test-openai-key' }),
    forkConfig: () => ({
      model: 'gpt-5.1',
      apiKey: 'test-openai-key',
      depth: 1,
      parentSessionId: 'parent-1',
    }),
  },
];

for (const branch of branches) {
  describe(`fresh-session presence — ${branch.name}`, () => {
    it('writes a presence file with a defined sessionId when config.sessionId is absent', async () => {
      triggerPresence(branch.makeProvider(), branch.freshConfig());
      const rec = await waitForAnyPresence();
      // THE REPRODUCER: before the fix this was undefined — no file at all.
      expect(rec).toBeDefined();
      expect(rec?.sessionId).toBeTypeOf('string');
      expect(rec?.sessionId).not.toBe('');
      expect(rec?.surface).toBe('cli');
      expect(rec?.actor).toBe('main');
    });

    it('does not write a second, differently-identified file on the next turn', async () => {
      const provider = branch.makeProvider();
      triggerPresence(provider, branch.freshConfig());
      const first = await waitForAnyPresence();
      expect(first).toBeDefined();

      // query() runs once per turn — a second turn must reuse the same id.
      triggerPresence(provider, branch.freshConfig());
      await new Promise((resolve) => setTimeout(resolve, 60));

      const records = await readPresenceFiles();
      expect(records).toHaveLength(1);
      expect(records[0]?.sessionId).toBe(first?.sessionId);
    });

    it('does not advertise presence for a fork', async () => {
      triggerPresence(branch.makeProvider(), branch.forkConfig());
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(await readPresenceFiles()).toHaveLength(0);
    });

    it('rewrites presence when the advertised id changes (/resume on a memoized instance)', async () => {
      // The REPL memoizes provider instances per model family for the life of
      // the process, so /resume builds a NEW session on an instance that has
      // already advertised the previous session's id. Before this fix the
      // once-per-instance guard suppressed the rewrite: the resumed session was
      // never advertised, and the closed session's file survived — leaving the
      // Telegram watcher tailing a ledger nothing writes to any more.
      const provider = branch.makeProvider();
      triggerPresence(provider, branch.freshConfig());
      const first = await waitForAnyPresence();
      expect(first?.sessionId).toBeTypeOf('string');

      triggerPresence(provider, { ...branch.freshConfig(), sessionId: 'resumed-target' });
      for (let i = 0; i < 100; i++) {
        const records = await readPresenceFiles();
        if (records[0]?.sessionId === 'resumed-target') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const records = await readPresenceFiles();
      // Exactly one record, and it names the LIVE session — the stale one is
      // removed first, so a crash mid-rewrite leaves absence, never two.
      expect(records).toHaveLength(1);
      expect(records[0]?.sessionId).toBe('resumed-target');
    });

    it('does not advertise a fresh session on a non-CLI surface', async () => {
      // Codex P1: buildDaemonSessionFactory builds a fresh top-level provider
      // per scheduled task, so minting for every surface left one stale
      // live-looking record (and, before the registry split, 3 listeners) per
      // task in a long-running daemon.
      for (const surface of ['daemon', 'telegram']) {
        triggerPresence(branch.makeProviderOnSurface(surface), branch.freshConfig());
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(await readPresenceFiles()).toHaveLength(0);
    });

    it('still advertises a non-CLI surface session that carries an explicit id', async () => {
      triggerPresence(branch.makeProviderOnSurface('daemon'), {
        ...branch.freshConfig(),
        sessionId: 'resumed-daemon-task',
      });
      const rec = await waitForAnyPresence();
      expect(rec?.sessionId).toBe('resumed-daemon-task');
      expect(rec?.surface).toBe('daemon');
    });
  });
}
