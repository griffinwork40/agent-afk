/**
 * AgentSession wiring for per-session private temp dirs: construction
 * allocates a TMPDIR into `config.env` (what the dispatcher hands bash and
 * test_run), and close() removes the dir only when this session created it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-tmpdir-life-home-'));
process.env['AFK_HOME'] = tmpHome;

import { AgentSession } from './agent-session.js';
import { createMockProvider } from '../__fixtures__/mock-provider.js';
import type { ProviderQueryArgs } from '../provider.js';
import { ensureSessionTmpdir, setSessionTmpdirRootForTests } from './session-tmpdir.js';

const root = path.join(tmpHome, 'tmp-root');

beforeAll(() => setSessionTmpdirRootForTests(root));
afterAll(() => {
  setSessionTmpdirRootForTests(undefined);
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function capturingProvider(seen: Array<Record<string, string> | undefined>) {
  const inner = createMockProvider({ sessionId: `tmpdir-${Date.now()}` });
  return {
    ...inner,
    query(args: ProviderQueryArgs) {
      seen.push(args.config.env);
      return inner.query(args);
    },
  };
}

describe('AgentSession private TMPDIR', () => {
  it('injects a session TMPDIR into the provider config and removes it on close', async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const session = new AgentSession({ model: 'sonnet', provider: capturingProvider(seen) });
    const env = seen[0];
    expect(env?.['TMPDIR']).toBeDefined();
    expect(path.dirname(env!['TMPDIR']!)).toBe(root);
    expect(ensureSessionTmpdir(env)).toBe(true); // what the first bash spawn does
    expect(fs.existsSync(env!['TMPDIR']!)).toBe(true);
    await session.close();
    expect(fs.existsSync(env!['TMPDIR']!)).toBe(false);
  });

  it('keeps an inherited TMPDIR (forks) and never deletes it on close', async () => {
    const inherited = path.join(tmpHome, 'inherited');
    fs.mkdirSync(inherited);
    const seen: Array<Record<string, string> | undefined> = [];
    const session = new AgentSession({
      model: 'sonnet',
      provider: capturingProvider(seen),
      env: { TMPDIR: inherited, PLUGIN_ROOT: '/plug' },
    });
    expect(seen[0]).toEqual({ TMPDIR: inherited, PLUGIN_ROOT: '/plug' });
    await session.close();
    expect(fs.existsSync(inherited)).toBe(true);
  });
});

describe('#2933 registry cleanup in close() finally block', () => {
  it('removes the session dir even when shutdown.dispatchOnce throws', async () => {
    // Arrange: a provider whose close() throws so the dispatchOnce chain
    // exercises error handling; we verify cleanup still runs.
    const inner = createMockProvider({ sessionId: `tmpdir-throw-${Date.now()}` });
    const throwingProvider = {
      ...inner,
      query(args: ProviderQueryArgs) {
        const q = inner.query(args);
        const originalClose = q.close.bind(q);
        return {
          ...q,
          close() {
            void originalClose();
            // Throw so one of the earlier close steps fails.
            throw new Error('simulated provider close failure');
          },
        };
      },
    };

    const seen: Array<Record<string, string> | undefined> = [];
    const session = new AgentSession({
      model: 'sonnet',
      provider: {
        ...throwingProvider,
        query(args: ProviderQueryArgs) {
          seen.push(args.config.env);
          return throwingProvider.query(args);
        },
      },
    });

    const e = seen[0];
    expect(e?.['TMPDIR']).toBeDefined();
    // Materialize the directory so we can observe its removal.
    expect(ensureSessionTmpdir(e)).toBe(true);
    const dir = e!['TMPDIR']!;
    expect(fs.existsSync(dir)).toBe(true);

    // close() may reject (provider threw) — but cleanup must still run.
    try {
      await session.close();
    } catch {
      // Expected: the simulated error may propagate.
    }

    // The session dir must have been cleaned up regardless of the error.
    expect(fs.existsSync(dir)).toBe(false);
  });
});
