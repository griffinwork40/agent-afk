/**
 * Presence session-id resolution contract.
 *
 * The bug this guards: presence was gated on `config.sessionId`, which is set
 * ONLY under `--resume`/`--continue`. Every fresh top-level session therefore
 * wrote NO presence file, so the Telegram bot's presence-driven auto-subscribe
 * loop (`telegram/bot.ts`, filters `surface === 'cli' && afk === true`) was
 * structurally blind to it, and bidirectional AFK — the agent asking a yes/no
 * question and the operator tapping an inline Telegram button — could never
 * work for a non-resumed session. The real id was minted downstream of the
 * gate, inside query construction, from the *different* `config.resume` field.
 *
 * `presence-surface.test.ts` did not catch it because every config it builds
 * passes an explicit `sessionId` — it only ever exercised the resumed shape.
 * The end-to-end cases below deliberately omit `sessionId`, which is the real
 * shape of a fresh REPL session (see `cli/commands/interactive/bootstrap.ts`,
 * where `sessionId` arrives only via `...deps.resumeConfig`).
 *
 * Harness note: the presence write is fire-and-forget but scheduled
 * *synchronously* inside `provider.query()`, before any streaming — so these
 * tests call `query()` once, never iterate it, and assert on the real presence
 * file under a temp `AFK_HOME`. No SDK mock is needed because the client is
 * built lazily and never used. Same approach as `presence-surface.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveTopLevelSessionId, isTopLevelSession } from './presence-lifecycle.js';
import {
  AnthropicDirectProvider,
  OpenAICompatibleProvider,
} from '../index.js';
import { readPresenceFiles, type PresenceFileInfo } from '../../awareness/presence.js';
import type { ModelProvider, ProviderQuery, ProviderUserTurn } from '../../provider.js';
import type { AgentConfig } from '../../types/config-types.js';

describe('resolveTopLevelSessionId', () => {
  const topLevel = { depth: undefined, parentSessionId: undefined };

  it('mints an id for a fresh top-level session that supplied none (the regression)', () => {
    const out = resolveTopLevelSessionId({
      sessionId: undefined,
      resume: undefined,
      ...topLevel,
      memoized: null,
    });
    // Before the fix this position held `config.sessionId` — undefined — so the
    // presence gate no-opped and no file was ever written.
    expect(out.id).toBeTypeOf('string');
    expect(out.id).not.toBe('');
    expect(out.memoized).toBe(out.id);
  });

  it('is stable across turns once memoized (query() runs once per turn)', () => {
    const first = resolveTopLevelSessionId({
      sessionId: undefined,
      resume: undefined,
      ...topLevel,
      memoized: null,
    });
    const second = resolveTopLevelSessionId({
      sessionId: undefined,
      resume: undefined,
      ...topLevel,
      memoized: first.memoized,
    });
    // A fresh mint per turn would move the ledger directory out from under the
    // presence file the Telegram watcher is already following.
    expect(second.id).toBe(first.id);
  });

  it('lets an explicit config.sessionId win unchanged (resume semantics)', () => {
    const out = resolveTopLevelSessionId({
      sessionId: 'resumed-abc',
      resume: undefined,
      ...topLevel,
      memoized: null,
    });
    expect(out.id).toBe('resumed-abc');
    expect(out.memoized).toBeNull(); // no mint burned
  });

  it('falls back to config.resume when sessionId is absent', () => {
    const out = resolveTopLevelSessionId({
      sessionId: undefined,
      resume: 'continued-xyz',
      ...topLevel,
      memoized: null,
    });
    expect(out.id).toBe('continued-xyz');
    expect(out.memoized).toBeNull();
  });

  it('prefers sessionId over resume when both are present', () => {
    const out = resolveTopLevelSessionId({
      sessionId: 'explicit',
      resume: 'fallback',
      ...topLevel,
      memoized: null,
    });
    expect(out.id).toBe('explicit');
  });

  it('never mints for a fork identified by depth', () => {
    const out = resolveTopLevelSessionId({
      sessionId: undefined,
      resume: undefined,
      depth: 1,
      parentSessionId: undefined,
      memoized: null,
    });
    // Forks must not inherit or share a minted id — that would collide on the
    // ledger directory. undefined ⇒ query keeps its own per-call mint.
    expect(out.id).toBeUndefined();
    expect(out.memoized).toBeNull();
  });

  it('never mints for a fork identified by parentSessionId', () => {
    const out = resolveTopLevelSessionId({
      sessionId: undefined,
      resume: undefined,
      depth: undefined,
      parentSessionId: 'parent-1',
      memoized: null,
    });
    expect(out.id).toBeUndefined();
    expect(out.memoized).toBeNull();
  });
});

describe('isTopLevelSession', () => {
  it('treats depth 0 / undefined with no parent as top-level', () => {
    expect(isTopLevelSession(undefined, undefined)).toBe(true);
    expect(isTopLevelSession(0, undefined)).toBe(true);
  });

  it('treats any depth > 0 or any parent id as a fork', () => {
    expect(isTopLevelSession(1, undefined)).toBe(false);
    expect(isTopLevelSession(0, 'parent')).toBe(false);
  });
});

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
  /** A fresh-session config — deliberately NO sessionId, as a new REPL builds. */
  freshConfig: () => AgentConfig;
  /** A fork config — must NOT advertise presence. */
  forkConfig: () => AgentConfig;
}

const branches: Branch[] = [
  {
    name: 'anthropic-direct',
    makeProvider: () => new AnthropicDirectProvider({}),
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
  });
}
