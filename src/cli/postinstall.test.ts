// Windows: .mjs dynamic import of scripts/postinstall.mjs fails on Windows (#703)
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';

// Invariant (no real service side effects): restartLaunchdServices'
// DEFAULT restartFn runs `node <repo>/dist/cli.mjs service restart <name>`,
// which rewrites the developer's REAL ~/Library/LaunchAgents plists and
// bootouts/bootstraps their live telegram bot and daemon. It fires whenever
// existsFn reports dist/cli.mjs present, which a real `pnpm build` makes true,
// or which a blanket `existsFn: () => true` fakes. This happened on
// 2026-09-26: an un-injected test repointed a live bot at a worktree build and
// sent its logs to a deleted tmp dir. Every child_process entry point is
// therefore mocked to record-and-throw, and afterEach fails the test that
// reached one. Inject execFn/restartFn instead.
const realChildProcessCalls: string[] = [];
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const refuse = (name: string) => (...args: unknown[]): never => {
    realChildProcessCalls.push(`${name} ${JSON.stringify(args[0])} ${JSON.stringify(args[1] ?? '')}`);
    throw new Error(`postinstall test reached real child_process.${name}; inject execFn/restartFn`);
  };
  return { ...actual, execSync: refuse('execSync'), execFileSync: refuse('execFileSync') };
});
afterEach(() => {
  const leaked = realChildProcessCalls.splice(0);
  expect(leaked, 'a test reached a real child_process call').toEqual([]);
});

const isWin32 = process.platform === 'win32';

type DetectPathGapFn = (
  prefix: string,
  pathEnv: string,
) => { onPath: boolean; binDir: string };

type RestartLaunchdServicesFn = (opts?: {
  home?: string;
  uid?: number;
  labels?: string[];
  existsFn?: (p: string) => boolean;
  execFn?: (argv: string[]) => void;
  restartFn?: (node: string, cli: string, name: string) => void;
}) => string[];

let detectPathGap: DetectPathGapFn;
let restartLaunchdServices: RestartLaunchdServicesFn;

beforeAll(async () => {
  // Dynamic import avoids TypeScript transform issues with plain .mjs files.
  const mod = await import('../../scripts/postinstall.mjs');
  detectPathGap = mod.detectPathGap as DetectPathGapFn;
  restartLaunchdServices = mod.restartLaunchdServices as RestartLaunchdServicesFn;
});

// detectPathGap is a pure function (string → string) with zero platform calls.
// The .mjs import guard (skipIf isWin32) protects restartLaunchdServices below,
// but detectPathGap is platform-independent and runs everywhere.
describe('detectPathGap', () => {
  it('returns onPath: true when binDir is already on PATH', () => {
    const result = detectPathGap('/usr/local', '/usr/local/bin:/usr/bin:/bin');
    expect(result.onPath).toBe(true);
    expect(result.binDir).toBe('/usr/local/bin');
  });

  it('returns onPath: false when binDir is not on PATH', () => {
    const result = detectPathGap('/usr/local', '/usr/bin:/bin');
    expect(result.onPath).toBe(false);
    expect(result.binDir).toBe('/usr/local/bin');
  });

  it('normalizes trailing slash on prefix', () => {
    const result = detectPathGap('/usr/local/', '/usr/local/bin:/usr/bin');
    expect(result.onPath).toBe(true);
    expect(result.binDir).toBe('/usr/local/bin');
  });

  it('normalizes trailing slash on PATH entries', () => {
    const result = detectPathGap('/usr/local', '/usr/local/bin/:/usr/bin');
    expect(result.onPath).toBe(true);
    expect(result.binDir).toBe('/usr/local/bin');
  });

  it('handles empty PATH gracefully', () => {
    const result = detectPathGap('/usr/local', '');
    expect(result.onPath).toBe(false);
    expect(result.binDir).toBe('/usr/local/bin');
  });

  it('handles single matching PATH entry', () => {
    const result = detectPathGap('/home/user/.npm-global', '/home/user/.npm-global/bin');
    expect(result.onPath).toBe(true);
    expect(result.binDir).toBe('/home/user/.npm-global/bin');
  });

  it('does not falsely match a prefix substring', () => {
    // /usr/local should not match /usr/local-extra/bin
    const result = detectPathGap('/usr/local', '/usr/local-extra/bin:/usr/bin');
    expect(result.onPath).toBe(false);
  });

  it('returns correct binDir for a home-scoped npm prefix', () => {
    const result = detectPathGap('/Users/alice/.npm-global', '/usr/bin');
    expect(result.binDir).toBe('/Users/alice/.npm-global/bin');
    expect(result.onPath).toBe(false);
  });
});

// F-6: test coverage for the CLI-path branch in restartLaunchdServices.
// existsFn controls both plist presence AND cli.mjs presence, so we can
// exercise the two branches (CLI-path taken, CLI-path skipped) without
// touching the filesystem or invoking launchctl.
describe.skipIf(isWin32)('restartLaunchdServices — CLI-path branch (F-6)', () => {
  it('uses restartFn (CLI path) when existsFn reports both plist and cli.mjs present', () => {
    const calls: Array<{ node: string; cli: string; name: string }> = [];
    const restarted = restartLaunchdServices({
      home: '/fake/home',
      uid: 501,
      labels: ['com.afk.daemon'],
      // existsFn: plist AND cli.mjs both "exist"
      existsFn: (_p: string) => true,
      restartFn: (node: string, cli: string, name: string) => {
        calls.push({ node, cli, name });
      },
      // execFn must not be called when restartFn succeeds
      execFn: (_argv: string[]) => {
        throw new Error('execFn should not be called when CLI path is taken');
      },
    });
    expect(restarted).toEqual(['com.afk.daemon']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('daemon');
    expect(calls[0]?.node).toBe(process.execPath);
    expect(calls[0]?.cli).toContain('cli.mjs');
  });

  it('falls back to execFn (raw kickstart) when existsFn reports cli.mjs absent', () => {
    // plist exists but cli.mjs does not — simulates a source checkout
    // without a build, or a fresh install where dist/ is not yet present.
    const kickstartArgvs: string[][] = [];
    const restarted = restartLaunchdServices({
      home: '/fake/home',
      uid: 501,
      labels: ['com.afk.daemon'],
      // existsFn: plist exists (path ends with .plist), cli.mjs absent
      existsFn: (p: string) => p.endsWith('.plist'),
      restartFn: (_node: string, _cli: string, _name: string) => {
        throw new Error('restartFn should not be called when cli.mjs is absent');
      },
      execFn: (argv: string[]) => {
        kickstartArgvs.push(argv);
      },
    });
    expect(restarted).toEqual(['com.afk.daemon']);
    expect(kickstartArgvs).toHaveLength(1);
    expect(kickstartArgvs[0]?.[0]).toBe('kickstart');
    expect(kickstartArgvs[0]?.[1]).toBe('-k');
    expect(kickstartArgvs[0]?.[2]).toContain('com.afk.daemon');
  });

  it('falls back to execFn when restartFn throws (CLI path failed)', () => {
    // CLI restart throws → should fall through to raw kickstart.
    const kickstartArgvs: string[][] = [];
    const restarted = restartLaunchdServices({
      home: '/fake/home',
      uid: 501,
      labels: ['com.afk.daemon'],
      existsFn: (_p: string) => true,
      restartFn: () => {
        throw new Error('simulated CLI restart failure');
      },
      execFn: (argv: string[]) => {
        kickstartArgvs.push(argv);
      },
    });
    expect(restarted).toEqual(['com.afk.daemon']);
    expect(kickstartArgvs).toHaveLength(1);
    expect(kickstartArgvs[0]?.[0]).toBe('kickstart');
  });

  it('skips labels whose plist does not exist', () => {
    // Only the daemon plist exists; telegram plist is absent.
    // existsFn must handle both the plist check (LaunchAgents path) and the
    // cli.mjs presence check (dist/cli.mjs path). Both daemon paths return
    // true so the CLI restart path fires for daemon; telegram is skipped
    // entirely at the plist guard.
    const restarted_names: string[] = [];
    const restarted = restartLaunchdServices({
      home: '/fake/home',
      uid: 501,
      labels: ['com.afk.daemon', 'com.afk.telegram'],
      // daemon plist and cli.mjs both "present"; telegram plist absent.
      existsFn: (p: string) => !p.includes('telegram'),
      restartFn: (_node: string, _cli: string, name: string) => {
        restarted_names.push(name);
      },
      execFn: (_argv: string[]) => {},
    });
    expect(restarted).toEqual(['com.afk.daemon']);
    expect(restarted_names).toEqual(['daemon']);
  });
});
