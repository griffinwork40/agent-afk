/**
 * Unit tests for the /reauth slash command.
 *
 * The command's contract: it must call `session.current.reauth()` to swap
 * the running SDK client, NOT only re-read the keychain. (Earlier versions
 * of the command bypassed the session and only touched the keychain — that
 * left the running SDK client holding the old account's token, defeating the
 * whole point of the command.)
 *
 * @module cli/slash/commands/reauth.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the keychain module before importing the command so the command's
// `loadClaudeCodeOauthToken` / `parseAccountIdentifier` imports resolve to our
// stubs.
vi.mock('../../../agent/auth/keychain.js', () => ({
  loadClaudeCodeOauthToken: vi.fn(),
  parseAccountIdentifier: vi.fn(),
}));

import { reauthCmd } from './reauth.js';
import type { SlashContext } from '../types.js';
import {
  loadClaudeCodeOauthToken,
  parseAccountIdentifier,
} from '../../../agent/auth/keychain.js';

type ReauthResult = { accountId: string; swapped: boolean } | null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedCtx extends SlashContext {
  lines: string[];
  successes: string[];
  infos: string[];
  warns: string[];
  errors: string[];
}

function makeCtx(
  reauthImpl: () => Promise<ReauthResult> | ReauthResult,
): CapturedCtx & { readonly reauthCalls: number } {
  const lines: string[] = [];
  const successes: string[] = [];
  const infos: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  // Wrap counter in an object so the getter below can read the live value
  // (a plain `let` captured by Object.assign would be evaluated once at
  // assign-time and freeze at 0).
  const counter = { value: 0 };

  const session = {
    current: {
      async reauth(): Promise<ReauthResult> {
        counter.value += 1;
        return await reauthImpl();
      },
    },
  } as unknown as SlashContext['session'];

  const ctx: CapturedCtx = {
    lines,
    successes,
    infos,
    warns,
    errors,
    session,
    stats: {} as SlashContext['stats'],
    out: {
      line: (s?: string) => { if (s !== undefined) lines.push(s); },
      raw: (s: string) => { lines.push(s); },
      success: (s: string) => { successes.push(s); },
      info: (s: string) => { infos.push(s); },
      warn: (s: string) => { warns.push(s); },
      error: (s: string) => { errors.push(s); },
    },
    ui: {} as SlashContext['ui'],
  };
  // Define the getter on the returned object so each read returns the live
  // counter, not a snapshot.
  Object.defineProperty(ctx, 'reauthCalls', {
    get: () => counter.value,
    enumerable: true,
  });
  return ctx as CapturedCtx & { readonly reauthCalls: number };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/reauth', () => {
  beforeEach(() => {
    vi.mocked(loadClaudeCodeOauthToken).mockReset();
    vi.mocked(parseAccountIdentifier).mockReset();
  });

  it('calls session.reauth() and reports the swapped account', async () => {
    vi.mocked(loadClaudeCodeOauthToken).mockReturnValue('sk-ant-oat01-old');
    vi.mocked(parseAccountIdentifier).mockReturnValue('old@example.com');

    const ctx = makeCtx(async () => ({ accountId: 'new@example.com', swapped: true }));

    const result = await reauthCmd.handler(ctx, '');

    expect(result).toBe('continue');
    expect(ctx.reauthCalls).toBe(1);
    // The success line must mention the new account name.
    expect(ctx.successes.some((s) => s.includes('new@example.com'))).toBe(true);
    expect(ctx.successes.some((s) => /swapped|now authenticated/i.test(s))).toBe(true);
  });

  it('reports "token unchanged" when reauth returns swapped:false', async () => {
    vi.mocked(loadClaudeCodeOauthToken).mockReturnValue('sk-ant-oat01-same');
    vi.mocked(parseAccountIdentifier).mockReturnValue('same@example.com');

    const ctx = makeCtx(async () => ({ accountId: 'same@example.com', swapped: false }));

    const result = await reauthCmd.handler(ctx, '');

    expect(result).toBe('continue');
    expect(ctx.reauthCalls).toBe(1);
    // The success line must indicate the token was already current.
    expect(ctx.successes.some((s) => /unchanged|up to date|already/i.test(s))).toBe(true);
  });

  it('reports api-key-mode hint when reauth returns null and a token exists', async () => {
    // null + token-present means: api-key mode, no OAuth refresher wired.
    vi.mocked(loadClaudeCodeOauthToken).mockReturnValue('sk-ant-oat01-fallback');
    vi.mocked(parseAccountIdentifier).mockReturnValue('fallback@example.com');

    const ctx = makeCtx(async () => null);

    const result = await reauthCmd.handler(ctx, '');

    expect(result).toBe('continue');
    expect(ctx.reauthCalls).toBe(1);
    // A warn line should be emitted about not using OAuth.
    expect(ctx.warns.length).toBeGreaterThan(0);
    expect(ctx.warns.some((s) => /api-key|ANTHROPIC_API_KEY|not using OAuth/i.test(s))).toBe(true);
  });

  it('reports no-credentials hint when reauth returns null and no token exists', async () => {
    vi.mocked(loadClaudeCodeOauthToken).mockReturnValue(undefined);
    vi.mocked(parseAccountIdentifier).mockReturnValue('');

    const ctx = makeCtx(async () => null);

    const result = await reauthCmd.handler(ctx, '');

    expect(result).toBe('continue');
    expect(ctx.warns.some((s) => /no.*credentials|claude login/i.test(s))).toBe(true);
  });

  it('handles reauth() throwing → error line + recovery hint, no rethrow', async () => {
    vi.mocked(loadClaudeCodeOauthToken).mockReturnValue('sk-ant-oat01-test');
    vi.mocked(parseAccountIdentifier).mockReturnValue('test@example.com');

    const ctx = makeCtx(async () => { throw new Error('network down'); });

    const result = await reauthCmd.handler(ctx, '');

    expect(result).toBe('continue');
    expect(ctx.errors.length).toBeGreaterThan(0);
    expect(ctx.errors.some((s) => s.includes('network down'))).toBe(true);
    // Must include the recovery hint pointing at `claude login`.
    expect(ctx.warns.some((s) => /claude login/i.test(s))).toBe(true);
  });

  it('--check: does NOT call session.reauth() — keychain probe only', async () => {
    vi.mocked(loadClaudeCodeOauthToken).mockReturnValue('sk-ant-oat01-keychain-only');
    vi.mocked(parseAccountIdentifier).mockReturnValue('keychain-only@example.com');

    const ctx = makeCtx(async () => {
      throw new Error('reauth should not be called in --check mode');
    });

    const result = await reauthCmd.handler(ctx, '--check');

    expect(result).toBe('continue');
    expect(ctx.reauthCalls).toBe(0);
    // Surfaces the account from the keychain probe.
    expect(ctx.successes.some((s) => s.includes('keychain-only@example.com'))).toBe(true);
    // And surfaces the disclaimer that the running client may still hold an
    // older token (so the user doesn't think --check rotated anything).
    expect(ctx.infos.some((s) => /running.*client|may still hold/i.test(s))).toBe(true);
  });

  it('--check with no token → warn + recovery hint, no reauth call', async () => {
    vi.mocked(loadClaudeCodeOauthToken).mockReturnValue(undefined);

    const ctx = makeCtx(async () => {
      throw new Error('reauth should not be called when no token');
    });

    const result = await reauthCmd.handler(ctx, '--check');

    expect(result).toBe('continue');
    expect(ctx.reauthCalls).toBe(0);
    expect(ctx.warns.some((s) => /no.*token|claude login/i.test(s))).toBe(true);
  });
});
