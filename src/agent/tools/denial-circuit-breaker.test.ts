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
  SUBAGENT_PATH_DENIAL_REASON_PREFIX,
  isSubagentContainmentDenial,
  extractDeniedReadPath,
  buildDenialBreakerMessage,
} from './denial-circuit-breaker.js';

// Representative non-containment hook-block reasons the breaker must IGNORE.
// Byte-for-byte prefixes of the real producers (path-approval-hook.ts's
// credential floor; an arbitrary user-defined PreToolUse hook).
const CREDENTIAL_DENYLIST_REASON =
  'Access denied: /home/u/.ssh/id_rsa is a protected credential/secret path ' +
  '(read-denylist entry: ~/.ssh). This path is never readable — it holds ' +
  'credentials, not task data; do not retry.';
const USER_HOOK_REASON = 'Blocked by org policy: reads of /vault/** are not allowed here.';

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

  it('isSubagentContainmentDenial: TRUE only for genuine path-approval containment reasons', () => {
    // The exact shape path-approval-hook.ts emits for a fork read outside roots.
    expect(
      isSubagentContainmentDenial(
        `${SUBAGENT_PATH_DENIAL_REASON_PREFIX} /out/x.ts is outside the session's granted read roots. Reads are confined…`,
      ),
    ).toBe(true);
    // Prefix is load-bearing and must stay in sync with the producer.
    expect(SUBAGENT_PATH_DENIAL_REASON_PREFIX).toBe('Sub-agent path access denied:');
  });

  it('isSubagentContainmentDenial: FALSE for the credential/secret read-denylist floor', () => {
    // A denylisted-secret block is never recoverable by widening readRoots
    // ("do not retry"), so the breaker's remedy would misdirect — must not count.
    expect(isSubagentContainmentDenial(CREDENTIAL_DENYLIST_REASON)).toBe(false);
  });

  it('isSubagentContainmentDenial: FALSE for arbitrary user-hook reasons and undefined', () => {
    expect(isSubagentContainmentDenial(USER_HOOK_REASON)).toBe(false);
    expect(isSubagentContainmentDenial(undefined)).toBe(false);
    expect(isSubagentContainmentDenial('')).toBe(false);
  });
});

// ---- Dispatcher integration ----------------------------------------------

const PARENT = 'parent-session-1';

/**
 * PreToolUse hook that path-approval-denies any call whose tool ∈ blockTools.
 * The block `reason` defaults to a genuine path-approval CONTAINMENT reason (so
 * the breaker counts it); pass a different `reason` to model the credential
 * read-denylist floor or a user hook (which must NOT count).
 */
function blockingHook(
  blockTools: ReadonlySet<string>,
  reason = `Sub-agent path access denied: outside the session's granted read roots`,
): HookRegistry {
  const registry = createHookRegistryImpl();
  registry.register('PreToolUse', async (ctx) => {
    if (ctx.event === 'PreToolUse' && blockTools.has(ctx.toolName)) {
      return { decision: 'block' as const, reason };
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
  /** Custom hook-block reason (default: a genuine containment denial). */
  reason?: string;
}): SessionToolDispatcher {
  return new SessionToolDispatcher({
    handlers: new Map<string, ToolHandler>([['echo', echoHandler()]]),
    schemas: [...builtinToolSchemas],
    permissions: { allowedTools: ['echo', 'read_file', 'list_directory', 'glob', 'grep', 'write_file'] },
    hookRegistry: blockingHook(opts.blockTools, opts.reason),
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

  it('trips through the parallel batch path too — first N-1 stay hook-block, Nth trips', async () => {
    const d = makeForkDispatcher({ blockTools: new Set(['read_file']) });
    const calls = Array.from({ length: DENIAL_CIRCUIT_BREAKER_THRESHOLD }, (_, i) => readCall(i));
    const results = await d.executeBatch(calls);
    // Denials are counted in index order during phase-1, so the first N-1 stay
    // ordinary hook-blocks and exactly the Nth (last) carries the trip. Stronger
    // than a bare `.some(...)`: it pins WHICH call trips and that earlier ones did not.
    for (let i = 0; i < DENIAL_CIRCUIT_BREAKER_THRESHOLD - 1; i++) {
      expect(results[i]!.failureClass).toBe('hook-block');
    }
    expect(results[DENIAL_CIRCUIT_BREAKER_THRESHOLD - 1]!.failureClass).toBe(
      DENIAL_BREAKER_FAILURE_CLASS,
    );
  });

  it('executeBatch reset-on-success: a successful sibling restarts the consecutive count', async () => {
    const d = makeForkDispatcher({ blockTools: new Set(['read_file']) });

    // Batch 1: N-1 denials + a successful echo. N-1 < threshold so no trip, and
    // the success fires the end-of-batch reset.
    const batch1: ToolCall[] = [
      ...Array.from({ length: DENIAL_CIRCUIT_BREAKER_THRESHOLD - 1 }, (_, i) => readCall(i + 1)),
      { id: 'echo-batch', name: 'echo', input: { message: 'progress' }, signal: new AbortController().signal },
    ];
    const r1 = await d.executeBatch(batch1);
    expect(r1.every((r) => r.failureClass !== DENIAL_BREAKER_FAILURE_CLASS)).toBe(true);
    expect(r1.some((r) => r.isError === undefined)).toBe(true); // echo succeeded

    // Batch 2: N-1 more denials. If the reset had NOT fired, the running count
    // would already be N-1 and the first denial here would be the Nth → trip.
    // It must stay below threshold, proving the reset landed.
    const batch2 = Array.from({ length: DENIAL_CIRCUIT_BREAKER_THRESHOLD - 1 }, (_, i) => readCall(100 + i));
    const r2 = await d.executeBatch(batch2);
    expect(r2.every((r) => r.failureClass === 'hook-block')).toBe(true);
  });

  it('credential/secret read-denylist blocks NEVER trip — only containment denials count', async () => {
    // A forked read hard-blocked by the credential floor ("do not retry") is not
    // recoverable by widening readRoots, so it must not trip this breaker even
    // well past the threshold. #546 review follow-up.
    const d = makeForkDispatcher({
      blockTools: new Set(['read_file']),
      reason: CREDENTIAL_DENYLIST_REASON,
    });
    for (let i = 0; i < DENIAL_CIRCUIT_BREAKER_THRESHOLD * 2; i++) {
      const r = await d.execute(readCall(i));
      expect(r.isError).toBe(true);
      expect(r.failureClass).toBe('hook-block'); // never 'denial-breaker'
    }
  });

  it('arbitrary user-hook read blocks NEVER trip — framework does not presume their semantics', async () => {
    const d = makeForkDispatcher({
      blockTools: new Set(['read_file']),
      reason: USER_HOOK_REASON,
    });
    for (let i = 0; i < DENIAL_CIRCUIT_BREAKER_THRESHOLD * 2; i++) {
      const r = await d.execute(readCall(i));
      expect(r.isError).toBe(true);
      expect(r.failureClass).toBe('hook-block'); // never 'denial-breaker'
    }
  });
});
