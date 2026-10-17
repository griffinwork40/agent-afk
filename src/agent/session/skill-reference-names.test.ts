import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mocks — vi.hoisted() ensures these vi.fn() instances are
// available inside the vi.mock() factory closures, which are hoisted to run
// before any import.
// ---------------------------------------------------------------------------

const { mockScanAllPluginRoots, mockExtractPluginSkills } = vi.hoisted(() => ({
  mockScanAllPluginRoots: vi.fn().mockReturnValue([{ type: 'local', path: '/fake/plugin' }]),
  mockExtractPluginSkills: vi.fn().mockReturnValue([{ name: 'research' }]),
}));

vi.mock('../../skills/skill-registry.js', () => ({
  listSkills: () => [],
}));

vi.mock('../tools/skill-bridge.js', () => ({
  scanAllPluginRoots: mockScanAllPluginRoots,
}));

vi.mock('../plugins/tool-injector.js', () => ({
  extractPluginSkills: mockExtractPluginSkills,
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
    // The module uses pluginNameInflight to deduplicate concurrent calls that
    // share the same cwd key. Both calls are enqueued synchronously before
    // any microtask runs (Promise.all starts both before awaiting either), so
    // the second call must find the inflight entry set by the first and reuse
    // its promise — meaning scanAllPluginRoots (and the full discovery path)
    // is invoked exactly once.
    //
    // mockScanAllPluginRoots returns a non-empty plugin root so that
    // extractPluginSkills can surface 'research', confirming both callers
    // received real data rather than an empty set that would pass regardless
    // of whether dedup fired.
    mockScanAllPluginRoots.mockClear();
    mockExtractPluginSkills.mockClear();
    mockScanAllPluginRoots.mockReturnValue([{ type: 'local', path: '/fake/plugin' }]);
    mockExtractPluginSkills.mockReturnValue([{ name: 'research' }]);

    // Use a unique cwd so the module's per-key TTL cache is cold.
    const cwd = `/tmp/test-dedup-${Date.now()}`;

    // Both calls start before either resolves — the JS event loop has not
    // yielded between them. The inflight map is populated synchronously inside
    // pluginSkillNames before the first `await loadPluginDiscovery()` returns,
    // so the second call must hit the inflight branch and return the same promise.
    const [r1, r2] = await Promise.all([
      resolveInstalledSkillNames(['research'], cwd),
      resolveInstalledSkillNames(['research'], cwd),
    ]);

    // Discovery must have run exactly once (inflight dedup worked).
    expect(mockScanAllPluginRoots).toHaveBeenCalledTimes(1);

    // Both callers must receive the same non-empty result.
    expect(r1.has('research')).toBe(true);
    expect(r2.has('research')).toBe(true);
    expect(r1).toEqual(r2);
  });
});
