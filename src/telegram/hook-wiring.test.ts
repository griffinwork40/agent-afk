/**
 * Telegram hook-wiring contract (PR #202 review H1 + L4, updated #528).
 *
 * Both Telegram session branches in `telegram.ts main()` — the Anthropic-direct
 * branch and the OpenAI-compatible ("codex") branch — MUST call
 * `seedPersistedGrants` so persisted grants from previous sessions are replayed.
 * Before the H1 fix the codex branch built `createDefaultHookRegistry(...).registry`
 * — discarding the bundle, never seeding. After #528, `pathApprovalGrantRef` has
 * been retired: the hooks read the grant manager exclusively from
 * `context.grantManager` (per-session, injected by the dispatcher since #527).
 *
 * This suite now pins:
 *   1. Each provider satisfies `GrantManager` (required for seeding to work).
 *   2. Persisted grants are reflected on the provider after seeding.
 * The `createDefaultHookRegistry` result no longer contains a `pathApprovalGrantRef`
 * field — that is the regression guard for the #528 retirement.
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

describe('Telegram hook wiring — grant seeding contract (PR #202 H1/L4, #528)', () => {
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
    it(`${name}: bundle has no pathApprovalGrantRef (#528) and reflects seeded grants`, () => {
      const bundle = createDefaultHookRegistry(
        undefined,
        'telegram',
        undefined,
        undefined,
        undefined,
        undefined,
        () => tmp,
      );

      // After #528: the bundle no longer contains `pathApprovalGrantRef` —
      // the hooks read the grant manager from context.grantManager instead.
      expect((bundle as Record<string, unknown>)['pathApprovalGrantRef']).toBeUndefined();

      // Must typecheck: the provider satisfies the GrantManager interface.
      const provider = make();

      // Seeding a persisted `allow` grant must surface on the provider —
      // this is what makes the `persist` elicitation choice survive across
      // sessions on this surface.
      const granted = join(tmp, 'granted-dir');
      const file = writePermissionsFile(tmp, granted);
      seedPersistedGrants(provider, file);
      expect(provider.getGrants().readRoots).toContain(granted);
    });
  }
});


