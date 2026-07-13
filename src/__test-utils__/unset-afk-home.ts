// Helper for suites that assert the UNSET-fallback path resolution
// (getAfkHome() → $HOME/.afk). The global setup redirect-paths-env.ts sets a
// sentinel AFK_HOME for every test file, which would shadow these suites'
// HOME-based tmp-dir isolation. Calling useUnsetAfkHome() at describe/file
// scope removes AFK_HOME before each test and restores the sentinel after,
// so the suite exercises the fallback while the rest of the file (and any
// suite that forgets to redirect HOME) stays pointed at the sentinel.
//
// Safety contract for callers: any suite using this helper MUST also point
// HOME at a throwaway tmp dir in its own beforeEach — with AFK_HOME unset,
// state-writing production code falls back to $HOME/.afk.
import { beforeEach, afterEach } from 'vitest';

export function useUnsetAfkHome(): void {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env['AFK_HOME']; // audit-env-access: allow — test-only env manipulation helper
    delete process.env['AFK_HOME']; // audit-env-access: allow — test-only env manipulation helper
  });
  afterEach(() => {
    if (saved !== undefined) process.env['AFK_HOME'] = saved; // audit-env-access: allow — restore sentinel
    else delete process.env['AFK_HOME']; // audit-env-access: allow — test-only env manipulation helper
  });
}
