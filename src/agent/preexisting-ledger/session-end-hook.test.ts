/**
 * Tests for the pre-existing-defect SessionEnd hook.
 *
 * Covers:
 *   - Subagent skip (parentSessionId set).
 *   - Disabled env var skip.
 *   - Missing session (no sidecar) is a no-op.
 *   - Writes a well-formed JSONL line to a temp AFK_HOME.
 *   - Append failure does not throw (best-effort contract).
 *
 * @module agent/preexisting-ledger/session-end-hook.test
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionEndContext } from '../hooks.js';

// We mock store.ts so tests don't need a real session file.
vi.mock('../facets/store.js', () => ({
  loadStoredSession: vi.fn(),
}));

import { loadStoredSession } from '../facets/store.js';
const mockLoadSession = vi.mocked(loadStoredSession);

function endCtx(over: Partial<SessionEndContext> = {}): SessionEndContext {
  return { event: 'SessionEnd', sessionId: 'sess-test-1', ...over };
}

function makeTempAfkHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'afk-preexisting-test-'));
  mkdirSync(join(dir, 'agent-framework'), { recursive: true });
  return dir;
}

describe('createPreexistingLedgerHook', () => {
  beforeEach(() => {
    mockLoadSession.mockReset();
    // Clear env overrides.
    delete process.env['AFK_PREEXISTING_LEDGER_DISABLE'];
    delete process.env['AFK_HOME'];
  });

  it('skips subagent sessions (parentSessionId set)', async () => {
    const { createPreexistingLedgerHook } = await import('./session-end-hook.js');
    const hook = createPreexistingLedgerHook();
    const result = hook(endCtx({ parentSessionId: 'parent-123' }));
    expect(result).toEqual({});
    expect(mockLoadSession).not.toHaveBeenCalled();
  });

  it('skips when disabled via env var', async () => {
    process.env['AFK_PREEXISTING_LEDGER_DISABLE'] = '1';
    const { createPreexistingLedgerHook } = await import('./session-end-hook.js');
    const hook = createPreexistingLedgerHook();
    const result = hook(endCtx());
    expect(result).toEqual({});
    expect(mockLoadSession).not.toHaveBeenCalled();
  });

  it('skips when sessionId is absent', async () => {
    const { createPreexistingLedgerHook } = await import('./session-end-hook.js');
    const hook = createPreexistingLedgerHook();
    const result = hook(endCtx({ sessionId: undefined }));
    expect(result).toEqual({});
    expect(mockLoadSession).not.toHaveBeenCalled();
  });

  it('is a no-op when session sidecar is missing', async () => {
    mockLoadSession.mockReturnValue(undefined);
    const { createPreexistingLedgerHook } = await import('./session-end-hook.js');
    const hook = createPreexistingLedgerHook();
    // Should not throw.
    expect(() => hook(endCtx())).not.toThrow();
  });

  it('writes a well-formed JSONL line when a pre-existing flag is found', async () => {
    const tmpHome = makeTempAfkHome();
    process.env['AFK_HOME'] = tmpHome;

    // Provide a stored session with one turn that has a real flag.
    mockLoadSession.mockReturnValue({
      model: 'claude-sonnet',
      startedAt: Date.now(),
      savedAt: Date.now(),
      totalTurns: 1,
      turns: [
        {
          user: '',
          assistant: 'scan:env:check fails — this is pre-existing, not introduced by my change',
        },
      ],
    } as ReturnType<typeof loadStoredSession>);

    const { createPreexistingLedgerHook } = await import('./session-end-hook.js');
    const hook = createPreexistingLedgerHook();
    hook(endCtx({ cwd: '/repo/test' }));

    // Read the ledger.
    const ledgerPath = join(tmpHome, 'agent-framework', 'preexisting-ledger.jsonl');
    const content = readFileSync(ledgerPath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);

    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record['sessionId']).toBe('sess-test-1');
    expect(record['signal']).toBe('preexisting-sentence');
    expect(record['repo']).toBe('/repo/test');
    expect(Array.isArray(record['loci'])).toBe(true);
    expect((record['loci'] as string[]).length).toBeGreaterThan(0);
    expect(typeof record['ts']).toBe('string');
    expect(typeof record['turn']).toBe('number');
  });

  it('does not throw when the ledger path is unwritable', async () => {
    // Use a fresh temp dir WITHOUT a pre-created agent-framework subdir so we
    // can place a FILE at that path; mkdirSync inside the hook will throw ENOTDIR.
    const tmpHome = mkdtempSync(join(tmpdir(), 'afk-preexisting-unwritable-'));
    process.env['AFK_HOME'] = tmpHome;

    // Write a FILE at the agent-framework path to force ENOTDIR when the hook
    // tries mkdirSync(dirname(ledgerPath), { recursive: true }).
    writeFileSync(join(tmpHome, 'agent-framework'), 'oops');

    mockLoadSession.mockReturnValue({
      model: 'claude-sonnet',
      startedAt: Date.now(),
      savedAt: Date.now(),
      totalTurns: 1,
      turns: [
        {
          user: '',
          assistant: 'scan:env:check fails — pre-existing, not mine',
        },
      ],
    } as ReturnType<typeof loadStoredSession>);

    const { createPreexistingLedgerHook } = await import('./session-end-hook.js');
    const hook = createPreexistingLedgerHook();
    // Must not throw.
    expect(() => hook(endCtx())).not.toThrow();
  });
});

describe('createPreexistingLedgerHook — in-memory assistant texts (no sidecar surfaces)', () => {
  beforeEach(() => {
    mockLoadSession.mockReset();
    delete process.env['AFK_PREEXISTING_LEDGER_DISABLE'];
    delete process.env['AFK_HOME'];
  });

  it('records from context.assistantTexts without reading a sidecar', async () => {
    const tmpHome = makeTempAfkHome();
    process.env['AFK_HOME'] = tmpHome;
    mockLoadSession.mockReturnValue(undefined);

    const { createPreexistingLedgerHook } = await import('./session-end-hook.js');
    const hook = createPreexistingLedgerHook();
    hook(endCtx({
      cwd: '/repo/oneshot',
      assistantTexts: ['hello', 'main is already red: `scan:env:check` fails, pre-existing'],
    }));

    expect(mockLoadSession).not.toHaveBeenCalled();
    const lines = readFileSync(join(tmpHome, 'agent-framework', 'preexisting-ledger.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record['turn']).toBe(1);
    expect(record['loci']).toContain('scan:env:check');
    expect(record['repo']).toBe('/repo/oneshot');
  });

  it('falls back to the sidecar when context texts are empty', async () => {
    mockLoadSession.mockReturnValue(undefined);
    const { resolveAssistantTexts } = await import('./session-end-hook.js');
    expect(resolveAssistantTexts('sess-x', [])).toBeUndefined();
    expect(mockLoadSession).toHaveBeenCalledTimes(1);
  });
});
