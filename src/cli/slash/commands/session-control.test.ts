import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionStats, recordTurn } from '../session-stats.js';
import { FastModeController } from '../../../agent/fast-mode.js';
import { HookBlockedError } from '../../../utils/errors.js';
import type { SlashContext } from '../types.js';
import { coreCommands } from './core.js';
import { fastCmd } from './fast.js';
import { mcpCmd } from './info.mcp.js';

const { ora, pending } = vi.hoisted(() => ({ ora: vi.fn(), pending: vi.fn() }));
vi.mock('ora', () => ({ default: ora }));
vi.mock('../../../agent/mcp/oauth.js', () => ({ readOauthPending: pending }));

function makeContext() {
  const stats = createSessionStats('sonnet');
  const lines: string[] = [];
  const out = {
    line: (s = '') => { lines.push(s); }, raw: (s: string) => { lines.push(s); },
    info: (s: string) => { lines.push(`INFO:${s}`); },
    warn: (s: string) => { lines.push(`WARN:${s}`); },
    success: (s: string) => { lines.push(`SUCCESS:${s}`); },
    error: (s: string) => { lines.push(`ERROR:${s}`); },
  };
  const session = {
    reset: vi.fn().mockResolvedValue(undefined),
    compact: vi.fn().mockResolvedValue({ compacted: true, messagesBefore: 50, messagesAfter: 4 }),
    listRewindTargets: vi.fn().mockReturnValueOnce([{}, {}, {}]).mockReturnValue([{}]),
    hookRegistry: { dispatch: vi.fn().mockResolvedValue(undefined) },
    waitForInitialization: vi.fn().mockResolvedValue({ mcpServers: [{ name: 'connected-server', status: 'connected' }, { name: 'pending-server', status: 'oauth_pending' }] }),
    sessionId: 'session',
  };
  const ctx = {
    session: { current: session }, stats, out,
    capabilities: new Set(['sessionControl']),
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
    ledger: { clear: vi.fn() }, fastMode: new FastModeController(),
    getFastModeContext: () => ({ resolvedModelId: 'claude-opus-5', providerFamily: 'anthropic-direct', hasCustomEndpoint: false, executionPath: 'top-level' }),
  } as unknown as SlashContext;
  return { ctx, session, lines };
}

beforeEach(() => { ora.mockReset(); pending.mockReset(); });

const clear = coreCommands.find((c) => c.name === '/clear')!;
const compact = coreCommands.find((c) => c.name === '/compact')!;

describe('canonical session-control handler adapters', () => {
  it('/clear clears provider, stats, ledger and UI with unchanged acknowledgment', async () => {
    const { ctx, session, lines } = makeContext();
    recordTurn(ctx.stats, 'old', 'old', { totalCostUsd: 1, sessionId: 'old' });
    expect(await clear.handler(ctx, '')).toBe('continue');
    expect(session.reset).toHaveBeenCalledOnce();
    expect(ctx.stats.totalTurns).toBe(0);
    expect(ctx.stats.sessionId).toBeUndefined();
    expect(ctx.stats.name).toBeUndefined();
    expect(ctx.ledger?.clear).toHaveBeenCalledOnce();
    expect(ctx.ui.clearScreen).toHaveBeenCalledOnce();
    expect(lines).toEqual(['SUCCESS:Conversation history cleared.']);
  });

  it('/clear leaves accounting/UI alone when reset fails', async () => {
    const { ctx, session, lines } = makeContext();
    ctx.stats.totalTurns = 4;
    session.reset.mockRejectedValue(new Error('cannot reset'));
    await clear.handler(ctx, '');
    expect(ctx.stats.totalTurns).toBe(4);
    expect(ctx.ledger?.clear).not.toHaveBeenCalled();
    expect(ctx.ui.clearScreen).not.toHaveBeenCalled();
    expect(lines).toEqual(['ERROR:cannot reset']);
  });

  it('/compact on an explicit non-TTY surface emits text, never starts ora', async () => {
    const { ctx, session, lines } = makeContext();
    await compact.handler(ctx, '');
    expect(session.hookRegistry.dispatch).toHaveBeenCalledWith({ event: 'PreCompact', sessionId: 'session', trigger: 'manual' });
    expect(ora).not.toHaveBeenCalled();
    expect(lines).toEqual(['INFO:Summarizing earlier turns...', 'SUCCESS:Compacted 3 → 1 prompts.']);
  });

  it('/compact blocked by PreCompact emits no false progress notice', async () => {
    const { ctx, session, lines } = makeContext();
    session.hookRegistry.dispatch.mockRejectedValue(new HookBlockedError('blocked', 'PreCompact', 'policy'));
    await compact.handler(ctx, '');
    expect(lines).toEqual(['INFO:Compaction skipped: policy']);
    expect(session.compact).not.toHaveBeenCalled();
    expect(ora).not.toHaveBeenCalled();
  });

  it('/fast preserves status, validation and acknowledgment output', async () => {
    const { ctx, lines } = makeContext();
    await fastCmd.handler(ctx, '');
    await fastCmd.handler(ctx, 'on');
    await fastCmd.handler(ctx, '');
    await fastCmd.handler(ctx, 'invalid');
    expect(lines).toEqual([
      'INFO:Fast mode preference: off.',
      'SUCCESS:Fast mode preference set to on. Takes effect on the next turn.',
      'INFO:Fast mode: active.', 'WARN:Usage: /fast [on|off]',
    ]);
    expect(ctx.fastMode?.getPreference()).toBe('on');
  });

  it('/fast with no controller keeps the clear surface-unavailable warning', async () => {
    const { ctx, lines } = makeContext();
    delete ctx.fastMode;
    await fastCmd.handler(ctx, 'on');
    expect(lines).toEqual(['WARN:Fast mode is unavailable on this surface.']);
  });

  it('/mcp status and OAuth continue rendering existing text via service readers', async () => {
    const { ctx, lines } = makeContext();
    await mcpCmd.handler(ctx, '');
    expect(lines.join('\n')).toContain('connected-server');
    expect(lines.join('\n')).toContain('pending-server');
    expect(lines.join('\n')).toContain('1 server(s) need OAuth');
    pending.mockReturnValue({ server: { timestamp: Date.now(), authorizationUrl: 'https://example.com/oauth' } });
    await mcpCmd.handler(ctx, 'auth');
    expect(lines.join('\n')).toContain('https://example.com/oauth');
    expect(lines.join('\n')).toContain('/mcp auth complete <serverName> <code>');
  });
});
