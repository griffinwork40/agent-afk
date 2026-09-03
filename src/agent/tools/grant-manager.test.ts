/**
 * Unit tests for PathGrantManager — the shared path-grant state machine.
 *
 * These tests exercise the implementation DIRECTLY (not via SessionToolDispatcher
 * or provider wrappers) to verify the three divergences reconciled in issue #500:
 *
 *   Finding 1 — per-call sessionId threading: per-call `sessionId?` argument
 *               wins over `getDefaultSessionId` hook; hook fires as fallback.
 *   Finding 2 — non-revocable anchor policy: `getProtectedRoot()` is called
 *               fresh on each `revokeRoot()`, so a migrating anchor (Option A /
 *               current cwd) is always honoured.
 *   Finding 3 — no-op revoke audit gate: `revokeRoot` emits NO audit entry when
 *               the path was never in the root lists (no-op revoke must not emit
 *               spurious log rows).
 *
 * @module agent/tools/grant-manager.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { PathGrantManager } from './grant-manager.js';
import type { PathGrantManagerHooks } from './grant-manager.js';

// ---------------------------------------------------------------------------
// Test-fixture helpers
// ---------------------------------------------------------------------------

/** Minimal hooks that own their own mutable arrays — the simplest consumer shape. */
function makeHooks(opts?: {
  initialRead?: string[];
  initialWrite?: string[];
  protectedRoot?: string;
  getDefaultSessionId?: () => string | undefined;
}): PathGrantManagerHooks & {
  _readRoots: string[];
  _writeRoots: string[];
  _protectedRoot: string | undefined;
} {
  const _readRoots: string[] = opts?.initialRead?.slice() ?? [];
  const _writeRoots: string[] = opts?.initialWrite?.slice() ?? [];
  let _protectedRoot: string | undefined = opts?.protectedRoot;
  return {
    _readRoots,
    _writeRoots,
    get _protectedRoot() {
      return _protectedRoot;
    },
    set _protectedRoot(v: string | undefined) {
      _protectedRoot = v;
    },
    getReadRoots: () => _readRoots,
    getWriteRoots: () => _writeRoots,
    getProtectedRoot: () => _protectedRoot,
    getAllowAll: () => false,
    getDefaultSessionId: opts?.getDefaultSessionId,
  };
}

// ---------------------------------------------------------------------------
// Audit-log helpers
// ---------------------------------------------------------------------------

let tmpHome: string;
let prevAfkHome: string | undefined;
let prevHome: string | undefined;

function setupAuditEnv(): void {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'pgm-test-'));
  prevAfkHome = process.env['AFK_HOME'];
  prevHome = process.env['HOME'];
  process.env['AFK_HOME'] = tmpHome;
  process.env['HOME'] = tmpHome;
}

function teardownAuditEnv(): void {
  if (prevAfkHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = prevAfkHome;
  if (prevHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = prevHome;
  rmSync(tmpHome, { recursive: true, force: true });
}

function readAuditEntries(): Array<Record<string, unknown>> {
  const candidates = [
    path.join(tmpHome, 'state', 'session-grants.jsonl'),
    path.join(tmpHome, '.afk', 'state', 'session-grants.jsonl'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return readFileSync(p, 'utf8')
        .trim()
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    }
  }
  return [];
}

// ===========================================================================
// 1. Core grant-state machine (no audit I/O needed)
// ===========================================================================

describe('PathGrantManager — addReadRoot', () => {
  it('adds the resolved path to the read-roots array', () => {
    const hooks = makeHooks();
    const gm = new PathGrantManager(hooks);
    gm.addReadRoot('/some/path', 'slash');
    expect(hooks._readRoots).toContain('/some/path');
  });

  it('is idempotent — repeated adds do not duplicate the entry', () => {
    const hooks = makeHooks();
    const gm = new PathGrantManager(hooks);
    gm.addReadRoot('/some/path', 'slash');
    gm.addReadRoot('/some/path', 'slash');
    gm.addReadRoot('/some/path', 'slash');
    expect(hooks._readRoots.filter((p) => p === '/some/path').length).toBe(1);
  });

  it('resolves the path to absolute before storing', () => {
    const hooks = makeHooks();
    const gm = new PathGrantManager(hooks);
    // path.resolve('/abs') === '/abs'; this ensures we aren't double-resolving
    gm.addReadRoot('/abs/path', 'slash');
    expect(hooks._readRoots).toContain('/abs/path');
  });

  it('does not touch writeRoots', () => {
    const hooks = makeHooks();
    const gm = new PathGrantManager(hooks);
    gm.addReadRoot('/read/only', 'slash');
    expect(hooks._writeRoots).not.toContain('/read/only');
  });

  it('calls ensureInitialized before adding (provider lazy-init hook)', () => {
    let initCalled = false;
    const _readRoots: string[] = [];
    const _writeRoots: string[] = [];
    const hooks: PathGrantManagerHooks = {
      getReadRoots: () => _readRoots,
      getWriteRoots: () => _writeRoots,
      ensureInitialized: () => { initCalled = true; },
      getProtectedRoot: () => undefined,
      getAllowAll: () => false,
    };
    const gm = new PathGrantManager(hooks);
    gm.addReadRoot('/p', 'slash');
    expect(initCalled).toBe(true);
  });

  it('is a no-op when getReadRoots returns undefined (uninitialized provider)', () => {
    const hooks: PathGrantManagerHooks = {
      getReadRoots: () => undefined,
      getWriteRoots: () => undefined,
      getProtectedRoot: () => undefined,
      getAllowAll: () => false,
    };
    const gm = new PathGrantManager(hooks);
    expect(() => gm.addReadRoot('/p', 'slash')).not.toThrow();
  });
});

describe('PathGrantManager — addWriteRoot', () => {
  it('adds path to both readRoots and writeRoots', () => {
    const hooks = makeHooks();
    const gm = new PathGrantManager(hooks);
    gm.addWriteRoot('/rw/path', 'slash');
    expect(hooks._readRoots).toContain('/rw/path');
    expect(hooks._writeRoots).toContain('/rw/path');
  });

  it('is idempotent on writeRoots', () => {
    const hooks = makeHooks();
    const gm = new PathGrantManager(hooks);
    gm.addWriteRoot('/rw/path', 'slash');
    gm.addWriteRoot('/rw/path', 'slash');
    expect(hooks._writeRoots.filter((p) => p === '/rw/path').length).toBe(1);
  });

  it('records a read→write upgrade (adds path that was already read-only to writeRoots)', () => {
    const hooks = makeHooks({ initialRead: ['/shared'] });
    const gm = new PathGrantManager(hooks);
    // Path is already a read root; addWriteRoot must add it to write roots.
    gm.addWriteRoot('/shared', 'slash');
    expect(hooks._writeRoots).toContain('/shared');
    expect(hooks._readRoots.filter((p) => p === '/shared').length).toBe(1);
  });
});

describe('PathGrantManager — revokeRoot', () => {
  it('removes path from both readRoots and writeRoots', () => {
    const hooks = makeHooks();
    const gm = new PathGrantManager(hooks);
    gm.addWriteRoot('/rw', 'slash');
    gm.revokeRoot('/rw', 'slash');
    expect(hooks._readRoots).not.toContain('/rw');
    expect(hooks._writeRoots).not.toContain('/rw');
  });

  it('is a structural no-op when path is not in any list', () => {
    const hooks = makeHooks();
    const gm = new PathGrantManager(hooks);
    // No grants added — revoking must not throw or mutate anything.
    const before = hooks._readRoots.length;
    expect(() => gm.revokeRoot('/never/added', 'slash')).not.toThrow();
    expect(hooks._readRoots.length).toBe(before);
  });

  it('is idempotent — double-revoking is a no-op', () => {
    const hooks = makeHooks();
    const gm = new PathGrantManager(hooks);
    gm.addReadRoot('/p', 'slash');
    gm.revokeRoot('/p', 'slash'); // first revoke — path removed
    expect(() => gm.revokeRoot('/p', 'slash')).not.toThrow(); // second — no-op
    expect(hooks._readRoots).not.toContain('/p');
  });

  // --- Finding 2: migrating anchor policy (Option A) ---

  it('(Finding 2) refuses to revoke the current protected root', () => {
    const hooks = makeHooks({ protectedRoot: '/anchor' });
    const gm = new PathGrantManager(hooks);
    hooks._readRoots.push('/anchor'); // manually put it in the list
    gm.revokeRoot('/anchor', 'slash');
    // Guard fired — path remains in readRoots.
    expect(hooks._readRoots).toContain('/anchor');
  });

  it('(Finding 2) allows revoking the old anchor after the protected root migrates', () => {
    const hooks = makeHooks({ protectedRoot: '/old-anchor' });
    const gm = new PathGrantManager(hooks);
    hooks._readRoots.push('/old-anchor');
    hooks._readRoots.push('/new-anchor');

    // Migrate the protected root (simulates setResolveBase / setCwd).
    hooks._protectedRoot = '/new-anchor';

    // /old-anchor is no longer the protected root — revoke must succeed.
    gm.revokeRoot('/old-anchor', 'slash');
    expect(hooks._readRoots).not.toContain('/old-anchor');
    // /new-anchor (the new anchor) is still protected.
    gm.revokeRoot('/new-anchor', 'slash');
    expect(hooks._readRoots).toContain('/new-anchor');
  });

  it('(Finding 2) is a no-op when getReadRoots is undefined (uninit provider)', () => {
    const hooks: PathGrantManagerHooks = {
      getReadRoots: () => undefined,
      getWriteRoots: () => undefined,
      getProtectedRoot: () => undefined,
      getAllowAll: () => false,
    };
    const gm = new PathGrantManager(hooks);
    expect(() => gm.revokeRoot('/p', 'slash')).not.toThrow();
  });
});

describe('PathGrantManager — getGrants', () => {
  it('returns a snapshot with all current roots', () => {
    const hooks = makeHooks({ protectedRoot: '/base' });
    hooks._readRoots.push('/base', '/extra-read');
    hooks._writeRoots.push('/base');
    const gm = new PathGrantManager(hooks);
    const grants = gm.getGrants();
    expect(grants.resolveBase).toBe('/base');
    expect(grants.readRoots).toContain('/base');
    expect(grants.readRoots).toContain('/extra-read');
    expect(grants.writeRoots).toContain('/base');
    expect(grants.allowAll).toBe(false);
  });

  it('returns defensive copies — mutations do not affect internal state', () => {
    const hooks = makeHooks();
    hooks._readRoots.push('/p');
    const gm = new PathGrantManager(hooks);
    const snap1 = gm.getGrants();
    snap1.readRoots.push('/injected');
    const snap2 = gm.getGrants();
    expect(snap2.readRoots).not.toContain('/injected');
  });

  it('uses getDisplayResolveBase when provided (back-compat hook)', () => {
    const hooks: PathGrantManagerHooks = {
      getReadRoots: () => [],
      getWriteRoots: () => [],
      getProtectedRoot: () => '/protected',
      getDisplayResolveBase: () => '/display-base',
      getAllowAll: () => false,
    };
    const gm = new PathGrantManager(hooks);
    expect(gm.getGrants().resolveBase).toBe('/display-base');
  });

  it('falls back to getProtectedRoot when getDisplayResolveBase is absent', () => {
    const hooks = makeHooks({ protectedRoot: '/my-base' });
    const gm = new PathGrantManager(hooks);
    expect(gm.getGrants().resolveBase).toBe('/my-base');
  });

  it('reflects getAllowAll from the hook', () => {
    const hooks: PathGrantManagerHooks = {
      getReadRoots: () => [],
      getWriteRoots: () => [],
      getProtectedRoot: () => undefined,
      getAllowAll: () => true,
    };
    const gm = new PathGrantManager(hooks);
    expect(gm.getGrants().allowAll).toBe(true);
  });
});

// ===========================================================================
// 2. Audit-log tests (Finding 1 + Finding 3 at the implementation layer)
// ===========================================================================

describe('PathGrantManager — audit log (Finding 1: sessionId, Finding 3: no-op gate)', () => {
  beforeEach(setupAuditEnv);
  afterEach(teardownAuditEnv);

  // --- Finding 1: per-call sessionId threading ---

  it('(Finding 1) per-call sessionId wins over getDefaultSessionId hook', () => {
    const hooks = makeHooks({ getDefaultSessionId: () => 'hook-default' });
    const gm = new PathGrantManager(hooks);
    gm.addReadRoot('/p', 'slash', 'per-call-id');
    const entries = readAuditEntries();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const last = entries[entries.length - 1]!;
    expect(last['sessionId']).toBe('per-call-id'); // per-call wins
  });

  it('(Finding 1) getDefaultSessionId hook fires when no per-call sessionId given', () => {
    const hooks = makeHooks({ getDefaultSessionId: () => 'ctor-default' });
    const gm = new PathGrantManager(hooks);
    gm.addReadRoot('/p', 'slash'); // no 3rd arg
    const entries = readAuditEntries();
    const last = entries[entries.length - 1]!;
    expect(last['sessionId']).toBe('ctor-default'); // hook fallback
  });

  it('(Finding 1) sessionId is null when neither per-call nor hook provides one', () => {
    const hooks = makeHooks(); // no getDefaultSessionId
    const gm = new PathGrantManager(hooks);
    gm.addReadRoot('/p', 'slash'); // no per-call sessionId either
    const entries = readAuditEntries();
    const last = entries[entries.length - 1]!;
    expect('sessionId' in last).toBe(true);
    expect(last['sessionId']).toBeNull();
  });

  it('(Finding 1) threads per-call sessionId through addWriteRoot', () => {
    const hooks = makeHooks({ getDefaultSessionId: () => 'hook-default' });
    const gm = new PathGrantManager(hooks);
    gm.addWriteRoot('/p', 'slash', 'write-per-call');
    const entries = readAuditEntries();
    const last = entries[entries.length - 1]!;
    expect(last['sessionId']).toBe('write-per-call');
    expect(last['action']).toBe('grant-write');
  });

  it('(Finding 1) threads per-call sessionId through revokeRoot', () => {
    const hooks = makeHooks({ getDefaultSessionId: () => 'hook-default' });
    const gm = new PathGrantManager(hooks);
    gm.addReadRoot('/p', 'slash', 'grant-id');
    gm.revokeRoot('/p', 'slash', 'revoke-id');
    const entries = readAuditEntries();
    const revoke = entries.find((e) => e['action'] === 'revoke')!;
    expect(revoke['sessionId']).toBe('revoke-id'); // per-call wins
  });

  // --- Finding 3: no-op revoke must not emit audit entry ---

  it('(Finding 3) emits NO audit entry when path was never granted', () => {
    const hooks = makeHooks();
    const gm = new PathGrantManager(hooks);
    const before = readAuditEntries().length;
    gm.revokeRoot('/never/added', 'slash');
    const after = readAuditEntries().length;
    expect(after).toBe(before); // zero new rows
  });

  it('(Finding 3) emits an audit entry when an existing read-root is revoked', () => {
    const hooks = makeHooks();
    const gm = new PathGrantManager(hooks);
    gm.addReadRoot('/p', 'slash', 'sess-1');
    const before = readAuditEntries().length;
    gm.revokeRoot('/p', 'slash', 'sess-2');
    const entries = readAuditEntries();
    expect(entries.length).toBe(before + 1);
    const last = entries[entries.length - 1]!;
    expect(last['action']).toBe('revoke');
    expect(last['path']).toBe('/p');
  });

  it('(Finding 3) emits NO extra entry on a double-revoke (second is no-op)', () => {
    const hooks = makeHooks();
    const gm = new PathGrantManager(hooks);
    gm.addReadRoot('/p', 'slash');
    gm.revokeRoot('/p', 'slash'); // real revoke — one entry
    const before = readAuditEntries().length;
    gm.revokeRoot('/p', 'slash'); // no-op — must not emit
    const after = readAuditEntries().length;
    expect(after).toBe(before);
  });

  it('(Finding 3) emits NO entry when revoking the protected root (guard fires first)', () => {
    const hooks = makeHooks({ protectedRoot: '/anchor' });
    hooks._readRoots.push('/anchor');
    const gm = new PathGrantManager(hooks);
    const before = readAuditEntries().length;
    gm.revokeRoot('/anchor', 'slash');
    const after = readAuditEntries().length;
    expect(after).toBe(before); // guard fires before removal — no audit row
  });

  it('(Finding 3) emits NO entry when provider is uninitialized (readRoots undefined)', () => {
    const hooks: PathGrantManagerHooks = {
      getReadRoots: () => undefined,
      getWriteRoots: () => undefined,
      getProtectedRoot: () => undefined,
      getAllowAll: () => false,
    };
    const gm = new PathGrantManager(hooks);
    const before = readAuditEntries().length;
    gm.revokeRoot('/p', 'slash');
    const after = readAuditEntries().length;
    expect(after).toBe(before);
  });

  // --- Audit dedup invariant (applies to grant paths too) ---

  it('emits exactly one audit row for repeated addReadRoot of the same path', () => {
    const hooks = makeHooks();
    const gm = new PathGrantManager(hooks);
    gm.addReadRoot('/dup', 'slash');
    gm.addReadRoot('/dup', 'slash');
    gm.addReadRoot('/dup', 'slash');
    const entries = readAuditEntries().filter((e) => e['path'] === '/dup');
    expect(entries.length).toBe(1);
  });

  it('emits grant-read then grant-write for a read→write upgrade (no duplicate read row)', () => {
    const hooks = makeHooks();
    const gm = new PathGrantManager(hooks);
    gm.addReadRoot('/up', 'slash');
    gm.addWriteRoot('/up', 'slash'); // read-root already present — only write-audit fires
    gm.addWriteRoot('/up', 'slash'); // idempotent — no additional row
    const entries = readAuditEntries().filter((e) => e['path'] === '/up');
    expect(entries.map((e) => e['action'])).toEqual(['grant-read', 'grant-write']);
  });

  // --- Audit entry schema ---

  it('every audit entry contains exactly the canonical key set', () => {
    const hooks = makeHooks();
    const gm = new PathGrantManager(hooks);
    gm.addReadRoot('/a', 'slash');
    gm.addWriteRoot('/b', 'tool');
    gm.revokeRoot('/a', 'slash');
    const entries = readAuditEntries();
    expect(entries.length).toBe(3);
    const expected = ['timestamp', 'sessionId', 'action', 'path', 'source'].sort();
    for (const e of entries) {
      expect(Object.keys(e).sort()).toEqual(expected);
    }
  });
});
