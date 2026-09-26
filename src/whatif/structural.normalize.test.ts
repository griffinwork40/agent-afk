import { describe, expect, it } from 'vitest';
import { normalizeSnapshot } from './structural.normalize.js';

describe('normalizeSnapshot', () => {
  it('rewrites sandbox home and cwd paths to the real paths', () => {
    const env = { label: 'candidate' as const, home: '/run/sandboxes/candidate/home', cwd: '/run/sandboxes/candidate/project/sub', launch: { env: {} } };
    const out = normalizeSnapshot(
      {
        model: 'm',
        system: 'Personal configuration (/run/sandboxes/candidate/home/AFK.md)\ncwd: /run/sandboxes/candidate/project/sub',
        tools: [{ name: 'x', description: 'reads /run/sandboxes/candidate/home/skills' }],
        firstUserMessage: 'hi',
      },
      env,
      { home: '/Users/me/.afk', cwd: '/repo/sub' },
    );
    expect(out.system).toBe('Personal configuration (/Users/me/.afk/AFK.md)\ncwd: /repo/sub');
    expect(out.tools[0]?.description).toBe('reads /Users/me/.afk/skills');
  });

  it('leaves the cwd alone when it is already the real cwd', () => {
    const env = { label: 'baseline' as const, home: '/run/b/home', cwd: '/repo', launch: { env: {} } };
    const out = normalizeSnapshot({ model: 'm', system: '/repo and /run/b/home', tools: [], firstUserMessage: '' }, env, { home: '/h', cwd: '/repo' });
    expect(out.system).toBe('/repo and /h');
  });
});
