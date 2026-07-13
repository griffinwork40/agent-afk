import { describe, expect, it } from 'vitest';
import { SessionToolDispatcher } from './dispatcher.js';
import { builtinToolSchemas } from './schemas.js';
import type { ToolCall, ToolHandler } from './types.js';
import { createHookRegistryImpl } from '../hook-registry.js';
import type { HookRegistry } from '../hooks.js';
import {
  DENIAL_CIRCUIT_BREAKER_THRESHOLD,
  DENIAL_BREAKER_FAILURE_CLASS,
  READ_PATH_TOOLS,
  extractDeniedReadPath,
  buildDenialBreakerMessage,
} from './denial-circuit-breaker.js';

// ---- Pure helpers ---------------------------------------------------------

describe('denial-circuit-breaker pure helpers', () => {
  it('threshold is a small positive constant (fixed, mirrors the repeat breaker)', () => {
    expect(DENIAL_CIRCUIT_BREAKER_THRESHOLD).toBe(5);
  });

  it('failure class is a distinct, non-generic tag', () => {
    expect(DENIAL_BREAKER_FAILURE_CLASS).toBe('denial-breaker');
  });

  it('READ_PATH_TOOLS covers path-reading tools but NOT write tools', () => {
    for (const t of ['read_file', 'list_directory', 'glob', 'grep']) {
      expect(READ_PATH_TOOLS.has(t)).toBe(true);
    }
    // Write-confinement is a separate mechanism — never counted by this breaker.
    for (const t of ['write_file', 'edit_file', 'bash']) {
      expect(READ_PATH_TOOLS.has(t)).toBe(false);
    }
  });

  it('extractDeniedReadPath pulls file_path for read_file', () => {
    expect(
      extractDeniedReadPath({
        id: '1',
        name: 'read_file',
        input: { file_path: '/repo/secret.ts' },
        signal: new AbortController().signal,
      }),
    ).toBe('/repo/secret.ts');
  });

  it('extractDeniedReadPath pulls path for list_directory/glob/grep', () => {
    for (const name of ['list_directory', 'glob', 'grep']) {
      expect(
        extractDeniedReadPath({
          id: '1',
          name,
          input: { path: '/repo/src' },
          signal: new AbortController().signal,
        }),
      ).toBe('/repo/src');
    }
  });

  it('extractDeniedReadPath falls back when no path arg is present (glob/grep default to cwd)', () => {
    expect(
      extractDeniedReadPath({
        id: '1',
        name: 'grep',
        input: { pattern: 'foo' },
        signal: new AbortController().signal,
      }),
    ).toBe('<grep with no explicit path>');
  });

  it('buildDenialBreakerMessage is loud + actionable: names count, paths, remedy, and confinement', () => {
    const msg = buildDenialBreakerMessage(['/a/one.ts', '/b/two.ts'], 5);
    expect(msg).toContain('5 consecutive');
    expect(msg).toContain('/a/one.ts');
    expect(msg).toContain('/b/two.ts');
    expect(msg).toContain('readRoots'); // the grant remedy
    expect(msg).toMatch(/afk farm/i); // deliberate-confinement framing
  });
});

// ---- Dispatcher integration ----------------------------------------------

const PARENT = 'parent-session-1';

/** PreToolUse hook that path-approval-denies any call whose tool ∈ blockTools. */
function blockingHook(blockTools: ReadonlySet<string>): HookRegistry {
  const registry = createHookRegistryImpl();
  registry.register('PreToolUse', async (ctx) => {
    if (ctx.event === 'PreToolUse' && blockTools.has(ctx.toolName)) {
      return {
        decision: 'block' as const,
        reason: `Sub-agent path access denied: outside the session's granted read roots`,
      };
    }
    return {};
  });
  return registry;
}

function echoHandler(): ToolHandler {
  return async (input: unknown) => ({ content: String((input as { message?: string }).message ?? 'ok') });
}

/** A dispatcher wired like a forked child (parentSessionId set) by default. */
function makeForkDispatcher(opts: {
  blockTools: ReadonlySet<string>;
  fork?: boolean;
}): SessionToolDispatcher {
  return new SessionToolDispatcher({
    handlers: new Map<string, ToolHandler>([['echo', echoHandler()]]),
    schemas: [...builtinToolSchemas],
    permissions: { allowedTools: ['echo', 'read_file', 'list_directory', 'glob', 'grep', 'write_file'] },
    hookRegistry: blockingHook(opts.blockTools),
    ...(opts.fork !== false ? { parentSessionId: PARENT } : {}),
  });
}

function readCall(n: number): ToolCall {
  return {
    id: `read-${n}`,
    name: 'read_file',
    input: { file_path: `/out-of-scope/file-${n}.ts` },
    signal: new AbortController().signal,
  };
}

describe('denial circuit breaker — dispatcher integration', () => {
  it('trips exactly at the threshold with an actionable denial-breaker result', async () => {
    const d = makeForkDispatcher({ blockTools: new Set(['read_file']) });

    // The first N-1 denials return the ordinary hook-block result.
    for (let i = 1; i < DENIAL_CIRCUIT_BREAKER_THRESHOLD; i++) {
      const r = await d.execute(readCall(i));
      expect(r.isError).toBe(true);
      expect(r.failureClass).toBe('hook-block');
      expect(r.content).toContain('blocked by PreToolUse hook');
    }

    // The Nth denial trips the breaker.
    const trip = await d.execute(readCall(DENIAL_CIRCUIT_BREAKER_THRESHOLD));
    expect(trip.isError).toBe(true);
    expect(trip.failureClass).toBe(DENIAL_BREAKER_FAILURE_CLASS);
    expect(trip.content).toContain('Denial circuit breaker');
    // Accumulated distinct denied paths are named in the loud message.
    expect(trip.content).toContain('/out-of-scope/file-1.ts');
    expect(trip.content).toContain(`/out-of-scope/file-${DENIAL_CIRCUIT_BREAKER_THRESHOLD}.ts`);
  });

  it('below-threshold denials do NOT trip', async () => {
    const d = makeForkDispatcher({ blockTools: new Set(['read_file']) });
    for (let i = 1; i < DENIAL_CIRCUIT_BREAKER_THRESHOLD; i++) {
      const r = await d.execute(readCall(i));
      expect(r.failureClass).toBe('hook-block');
    }
  });

  it('WRITE denials never count — write-confinement (worktree isolation) is untouched', async () => {
    const d = makeForkDispatcher({ blockTools: new Set(['write_file']) });
    for (let i = 0; i < DENIAL_CIRCUIT_BREAKER_THRESHOLD * 2; i++) {
      const r = await d.execute({
        id: `w-${i}`,
        name: 'write_file',
        input: { file_path: `/out/x-${i}.ts`, content: 'x' },
        signal: new AbortController().signal,
      });
      expect(r.isError).toBe(true);
      expect(r.failureClass).toBe('hook-block'); // never 'denial-breaker'
    }
  });

  it('interactive (non-fork) sessions never trip — only forks auto-deny', async () => {
    const d = makeForkDispatcher({ blockTools: new Set(['read_file']), fork: false });
    for (let i = 0; i < DENIAL_CIRCUIT_BREAKER_THRESHOLD * 2; i++) {
      const r = await d.execute(readCall(i));
      expect(r.isError).toBe(true);
      expect(r.failureClass).toBe('hook-block'); // never 'denial-breaker'
    }
  });

  it('resets on any successful tool call (counts consecutive denials, not lifetime)', async () => {
    const d = makeForkDispatcher({ blockTools: new Set(['read_file']) });

    // 4 denials (one below threshold), then a SUCCESS resets the count.
    for (let i = 1; i < DENIAL_CIRCUIT_BREAKER_THRESHOLD; i++) {
      const r = await d.execute(readCall(i));
      expect(r.failureClass).toBe('hook-block');
    }
    const ok = await d.execute({
      id: 'echo-1',
      name: 'echo',
      input: { message: 'progress' },
      signal: new AbortController().signal,
    });
    expect(ok.isError).toBeUndefined();

    // 4 more denials post-reset still do NOT trip (count restarted at 1).
    for (let i = 1; i < DENIAL_CIRCUIT_BREAKER_THRESHOLD; i++) {
      const r = await d.execute(readCall(100 + i));
      expect(r.failureClass).toBe('hook-block');
    }
    // The Nth consecutive denial after the reset finally trips.
    const trip = await d.execute(readCall(200));
    expect(trip.failureClass).toBe(DENIAL_BREAKER_FAILURE_CLASS);
  });

  it('trips through the parallel batch path too', async () => {
    const d = makeForkDispatcher({ blockTools: new Set(['read_file']) });
    const calls = Array.from({ length: DENIAL_CIRCUIT_BREAKER_THRESHOLD }, (_, i) => readCall(i));
    const results = await d.executeBatch(calls);
    // At least the tripping (Nth) call carries the denial-breaker class.
    expect(results.some((r) => r.failureClass === DENIAL_BREAKER_FAILURE_CLASS)).toBe(true);
  });
});
