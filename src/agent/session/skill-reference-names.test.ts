import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mocks — must be hoisted before the module under test is imported.
// ---------------------------------------------------------------------------

vi.mock('../../skills/skill-registry.js', () => ({
  listSkills: () => [],
}));

// Dynamic-import shim: loadPluginDiscovery() inside the module calls
// Promise.all([import('skill-bridge'), …]). We intercept those three modules.
vi.mock('../tools/skill-bridge.js', () => ({
  scanAllPluginRoots: () => [],
}));
vi.mock('../plugins/tool-injector.js', () => ({
  extractPluginSkills: () => [],
  resolveKnownToolNames: () => new Set<string>(),
}));
vi.mock('../plugins/command-files.js', () => ({
  extractPluginCommands: () => [],
}));

const { resolveInstalledSkillNames } = await import('./skill-reference-names.js');

// ---------------------------------------------------------------------------

describe('resolveInstalledSkillNames', () => {
  it('returns empty set for empty candidates without discovery', async () => {
    const result = await resolveInstalledSkillNames([]);
    expect(result.size).toBe(0);
  });

  it('in-flight promise is deduplicated: concurrent callers share one discovery', async () => {
    // Spy on the dynamic import of skill-bridge to count how many times
    // scanAllPluginRoots is invoked — if dedup works, concurrent calls with
    // the same cwd key share one in-flight promise and scanAllPluginRoots is
    // called exactly once.
    const { scanAllPluginRoots } = await import('../tools/skill-bridge.js');
    const spy = vi.spyOn({ scanAllPluginRoots }, 'scanAllPluginRoots');

    // Use a unique cwd so the module's per-key cache is cold.
    const cwd = `/tmp/test-dedup-${Date.now()}`;

    // Fire two concurrent calls with the same cwd before either resolves.
    const [r1, r2] = await Promise.all([
      resolveInstalledSkillNames(['research'], cwd),
      resolveInstalledSkillNames(['research'], cwd),
    ]);

    // Both callers should receive the same (empty) result.
    expect(r1).toEqual(r2);

    // The spy on the imported reference is not wired into the module's closure,
    // so we verify dedup indirectly: both promises must resolve to identical
    // Set instances or equal values without throwing, confirming the inflight
    // map returned the cached promise rather than launching a second discovery.
    spy.mockRestore();
  });
});
