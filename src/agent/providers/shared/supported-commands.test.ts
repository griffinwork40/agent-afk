/**
 * Tests for `collectSupportedCommands` scope filtering (#3442).
 *
 * Verifies:
 *  - No scope => all discovered entries returned.
 *  - `skillAllowlist` => only listed skills returned.
 *  - `pluginConfigs: []` => no plugin skills (only registry skills).
 *  - Errors => empty array (best-effort).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { collectSupportedCommands } from './supported-commands.js';

// --- mocks ------------------------------------------------------------------

const mockCollectSkillEntries = vi.fn();

vi.mock('../../tools/skill-bridge.js', () => ({
  collectSkillEntries: (...args: unknown[]) => mockCollectSkillEntries(...args),
}));

const ENTRIES = [
  { name: 'mint', description: 'Mint a PR', source: 'builtin' as const },
  { name: 'review', description: 'Review code', source: 'plugin' as const },
  { name: 'ground-state', description: 'Reconnaissance', source: 'builtin' as const },
];

// --- tests ------------------------------------------------------------------

describe('collectSupportedCommands — scope filtering (#3442)', () => {
  beforeEach(() => {
    mockCollectSkillEntries.mockReset();
    mockCollectSkillEntries.mockReturnValue(ENTRIES);
  });

  it('no scope => all entries returned, collectSkillEntries called without pluginConfigs', async () => {
    const result = await collectSupportedCommands();
    expect(result).toHaveLength(3);
    expect(result.map((e) => e.name)).toEqual(['mint', 'review', 'ground-state']);
    // pluginConfigs undefined => scan all plugin roots
    expect(mockCollectSkillEntries).toHaveBeenCalledWith(undefined);
  });

  it('skillAllowlist restricts returned entries', async () => {
    const result = await collectSupportedCommands({ skillAllowlist: ['mint', 'ground-state'] });
    expect(result.map((e) => e.name)).toEqual(['mint', 'ground-state']);
    expect(result.find((e) => e.name === 'review')).toBeUndefined();
  });

  it('skillAllowlist: [] => no entries returned', async () => {
    const result = await collectSupportedCommands({ skillAllowlist: [] });
    expect(result).toHaveLength(0);
  });

  it('pluginConfigs: [] is forwarded to collectSkillEntries', async () => {
    await collectSupportedCommands({ pluginConfigs: [] });
    expect(mockCollectSkillEntries).toHaveBeenCalledWith([]);
  });

  it('errors => returns empty array (best-effort)', async () => {
    mockCollectSkillEntries.mockImplementation(() => { throw new Error('scan failed'); });
    const result = await collectSupportedCommands();
    expect(result).toEqual([]);
  });

  it('undefined allowlist => no gate applied', async () => {
    const result = await collectSupportedCommands({ skillAllowlist: undefined });
    expect(result).toHaveLength(3);
  });

  it('maps all metadata fields from entries', async () => {
    mockCollectSkillEntries.mockReturnValue([{
      name: 'fancy',
      description: 'Fancy skill',
      source: 'user' as const,
      argumentHint: '<arg>',
      whenToUse: 'When fancy',
      flags: ['--verbose'],
      category: 'dev',
    }]);
    const result = await collectSupportedCommands();
    expect(result[0]).toMatchObject({
      name: 'fancy',
      description: 'Fancy skill',
      source: 'user',
      argumentHint: '<arg>',
      whenToUse: 'When fancy',
      flags: ['--verbose'],
      category: 'dev',
    });
  });
});
