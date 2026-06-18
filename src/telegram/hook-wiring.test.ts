/**
 * Telegram hook-wiring contract (PR #202 review H1 + L4).
 *
 * Both Telegram session branches in `telegram.ts main()` — the Anthropic-direct
 * branch and the OpenAI-compatible ("codex") branch — MUST wire
 * `pathApprovalGrantRef.current` to their provider and call
 * `seedPersistedGrants`, or path-approval AND the bash interpreter denylist
 * silently fail open for that surface (the hooks are registered but no-op
 * because `getGrantManager()` returns undefined). Before the H1 fix the codex
 * branch built `createDefaultHookRegistry(...).registry` — discarding the
 * bundle, never wiring the ref, never seeding.
 *
 * The literal `createSession` closure in `telegram.ts main()` cannot be reached
 * from a test (see `telegram/construct-session.ts`), so this pins the wiring
 * CONTRACT both branches depend on: each provider must satisfy `GrantManager`,
 * accept assignment to the hook bundle's grant ref, and reflect persisted
 * grants once seeded. A regression that makes the OpenAI-compatible provider
 * unwirable (the H1 class of bug) trips here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createDefaultHookRegistry,
  _resetWarningForTests,
} from '../agent/default-hook-registry.js';
import { AnthropicDirectProvider, OpenAICompatibleProvider } from '../agent/providers/index.js';
import type { GrantManager } from '../cli/slash/commands/allow-dir.js';
import { seedPersistedGrants, generateUlid, type PermissionsFile } from '../agent/permissions-store.js';

function writePermissionsFile(dir: string, absPath: string): string {
  const file = join(dir, 'permissions.json');
  const contents: PermissionsFile = {
    version: 1,
    grants: [
      {
        id: generateUlid(),
        path: absPath,
        mode: 'read',
        decision: 'allow',
        grantedAt: new Date().toISOString(),
        source: 'elicit:telegram',
      },
    ],
  };
  writeFileSync(file, JSON.stringify(contents, null, 2), 'utf8');
  return file;
}

// One entry per Telegram session branch. Both must be wirable identically.
const providerFactories: Record<string, () => GrantManager> = {
  // Anthropic-direct branch (telegram.ts: `directProvider`).
  AnthropicDirectProvider: () => new AnthropicDirectProvider(),
  // OpenAI-compatible / codex branch (telegram.ts: `codexProvider`, the H1 fix).
  OpenAICompatibleProvider: () => new OpenAICompatibleProvider(),
};

describe('Telegram hook wiring — path-approval grant ref (PR #202 H1/L4)', () => {
  let tmp: string;

  beforeEach(() => {
    _resetWarningForTests();
    tmp = mkdtempSync(join(tmpdir(), 'afk-tg-wiring-'));
  });

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  for (const [name, make] of Object.entries(providerFactories)) {
    it(`${name}: grant ref starts unwired, accepts the provider, and reflects seeded grants`, () => {
      const bundle = createDefaultHookRegistry(
        undefined,
        'telegram',
        undefined,
        undefined,
        undefined,
        undefined,
        () => tmp,
      );

      // Hooks are registered but the ref is unwired until the bootstrap sets it
      // — the exact fail-open state the codex branch was stuck in (H1).
      expect(bundle.pathApprovalGrantRef.current).toBeUndefined();

      // Must typecheck: the provider satisfies the GrantManager interface.
      const provider = make();
      bundle.pathApprovalGrantRef.current = provider;
      expect(bundle.pathApprovalGrantRef.current).toBe(provider);

      // Seeding a persisted `allow` grant must surface on the wired provider —
      // this is what makes the `persist` elicitation choice survive across
      // sessions on this surface.
      const granted = join(tmp, 'granted-dir');
      const file = writePermissionsFile(tmp, granted);
      seedPersistedGrants(provider, file);
      expect(provider.getGrants().readRoots).toContain(granted);
    });
  }
});
