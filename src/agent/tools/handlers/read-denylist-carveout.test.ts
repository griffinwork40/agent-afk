/**
 * #779 — the `AFK_HOME`-relocated `mcp.json` carve-out must not punch a hole
 * through a DIFFERENT builtin denied root.
 *
 * Contract under test: the carve-out reaches `<afkHome>/config/mcp.json` through
 * the denied `<afkHome>/config` root, and nothing else. When the operator
 * relocates the home underneath another floor, that floor still wins.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gateDerivedCarveOuts } from './read-denylist-carveout.js';
import { isReadDenied } from './read-denylist.js';

/** A builtin-denied credential root other than the AFK home. */
const OTHER_DENIED_ROOT = join(homedir(), '.gnupg');

describe('gateDerivedCarveOuts — pure gate', () => {
  const home = homedir();

  it('keeps a carve-out whose only containing root is the one it pierces', () => {
    const entry = join(home, '.afk', 'config', 'mcp.json');
    const carved = join(home, '.afk', 'config');
    expect(gateDerivedCarveOuts([entry], [carved, OTHER_DENIED_ROOT], [carved])).toEqual([entry]);
  });

  it('drops a carve-out that also sits under another builtin denied root', () => {
    const entry = join(OTHER_DENIED_ROOT, 'afk', 'config', 'mcp.json');
    const carved = join(OTHER_DENIED_ROOT, 'afk', 'config');
    expect(gateDerivedCarveOuts([entry], [carved, OTHER_DENIED_ROOT], [carved])).toEqual([]);
  });

  it('keeps a carve-out under a relocated home that is not denied elsewhere', () => {
    const entry = join(home, 'scratch', 'afk', 'config', 'mcp.json');
    const carved = join(home, 'scratch', 'afk', 'config');
    expect(gateDerivedCarveOuts([entry], [carved, OTHER_DENIED_ROOT], [carved])).toEqual([entry]);
  });

  it('excludes the pierced root by EQUALITY, not by prefix', () => {
    // The discriminator is load-bearing: the other denied root is a PREFIX of
    // the relocated home but not equal to the pierced root, so it must stay in
    // the gate. A prefix-based exclusion would re-open the hole.
    const entry = join(OTHER_DENIED_ROOT, 'afk', 'config', 'mcp.json');
    const carved = join(OTHER_DENIED_ROOT, 'afk', 'config');
    expect(gateDerivedCarveOuts([entry], [OTHER_DENIED_ROOT], [carved])).toEqual([]);
  });

  it('does not treat a sibling path sharing a name prefix as contained', () => {
    const entry = join(`${OTHER_DENIED_ROOT}-extra`, 'config', 'mcp.json');
    const carved = join(`${OTHER_DENIED_ROOT}-extra`, 'config');
    expect(gateDerivedCarveOuts([entry], [carved, OTHER_DENIED_ROOT], [carved])).toEqual([entry]);
  });

  it('fails closed on an empty carved-root set', () => {
    const entry = join(home, '.afk', 'config', 'mcp.json');
    expect(gateDerivedCarveOuts([entry], [join(home, '.afk', 'config')], [])).toEqual([]);
  });
});

describe('read denylist — relocated AFK_HOME under a denied root (#779)', () => {
  // The resolveLists() memo is keyed on AFK_HOME + AFK_READ_DENYLIST, so
  // reassigning the env var is enough to rebuild it — no module reload needed.
  // Matches the existing #740 relocation tests in read-denylist.test.ts.
  beforeEach(() => {
    delete process.env['AFK_HOME'];
    delete process.env['AFK_READ_DENYLIST'];
  });

  afterEach(() => {
    delete process.env['AFK_HOME'];
    delete process.env['AFK_READ_DENYLIST'];
  });

  it('refuses the derived mcp.json carve-out when AFK_HOME is under another floor', () => {
    process.env['AFK_HOME'] = join(OTHER_DENIED_ROOT, 'afk');
    const target = join(OTHER_DENIED_ROOT, 'afk', 'config', 'mcp.json');
    expect(isReadDenied(target).denied).toBe(true);
  });

  it('names the outer floor as the matching root, not the AFK config dir', () => {
    process.env['AFK_HOME'] = join(OTHER_DENIED_ROOT, 'afk');
    const verdict = isReadDenied(join(OTHER_DENIED_ROOT, 'afk', 'config', 'mcp.json'));
    expect(verdict.matched).toBe(OTHER_DENIED_ROOT);
  });

  it('still allows the carve-out for the default AFK_HOME', () => {
    const target = join(homedir(), '.afk', 'config', 'mcp.json');
    expect(isReadDenied(target).denied).toBe(false);
  });

  it('still allows the carve-out for a relocated home outside every denied root', () => {
    process.env['AFK_HOME'] = join(homedir(), 'afk-relocated-779');
    const target = join(homedir(), 'afk-relocated-779', 'config', 'mcp.json');
    expect(isReadDenied(target).denied).toBe(false);
  });

  it('keeps the sibling afk.env denied under a relocated home', () => {
    process.env['AFK_HOME'] = join(homedir(), 'afk-relocated-779');
    const target = join(homedir(), 'afk-relocated-779', 'config', 'afk.env');
    expect(isReadDenied(target).denied).toBe(true);
  });

  it('lets an operator AFK_READ_DENYLIST entry still outrank the carve-out', () => {
    const target = join(homedir(), '.afk', 'config', 'mcp.json');
    process.env['AFK_READ_DENYLIST'] = target;
    expect(isReadDenied(target).denied).toBe(true);
  });
});
