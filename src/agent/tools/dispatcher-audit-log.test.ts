/**
 * Tests for SessionToolDispatcher.appendAuditLog — schema symmetry with
 * AnthropicDirectProvider.appendProviderAuditLog.
 *
 * Both emission sites must produce the identical shape
 * `{ timestamp, sessionId, action, path, source }` with `sessionId` always
 * present (`null` when no session is bound). This prevents downstream log
 * consumers from seeing a mixed schema where one path emits `sessionId: undefined`
 * (which JSON.stringify drops) and the other emits `sessionId: null`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SessionToolDispatcher } from './dispatcher.js';
import { builtinToolSchemas } from './schemas.js';
import type { ToolHandler } from './types.js';

describe('SessionToolDispatcher audit log — sessionId schema symmetry', () => {
  let tmpHome: string;
  let prevAfkHome: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    // Isolate audit log to a temp dir so the test is hermetic.
    tmpHome = mkdtempSync(path.join(tmpdir(), 'dispatcher-audit-test-'));
    prevAfkHome = process.env['AFK_HOME'];
    prevHome = process.env['HOME'];
    process.env['AFK_HOME'] = tmpHome;
    process.env['HOME'] = tmpHome;
  });

  afterEach(() => {
    if (prevAfkHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = prevAfkHome;
    if (prevHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prevHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function readAuditEntries(): Array<Record<string, unknown>> {
    // Matches paths.ts resolution: <AFK_HOME>/state/session-grants.jsonl
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

  function noopHandler(): ToolHandler {
    return async () => ({ content: '' });
  }

  function makeDispatcher(sessionId?: string): SessionToolDispatcher {
    return new SessionToolDispatcher({
      handlers: new Map([['echo', noopHandler()]]),
      schemas: [...builtinToolSchemas],
      cwd: '/tmp/dispatcher-audit-base',
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
  }

  it('emits sessionId=null when no sessionId is bound (addReadRoot)', () => {
    const dispatcher = makeDispatcher();
    dispatcher.addReadRoot('/some/path', 'slash');
    const entries = readAuditEntries();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const e = entries[entries.length - 1]!;
    // Field must be present (post-fix); value must be null (not undefined
    // which JSON.stringify would drop entirely).
    expect('sessionId' in e).toBe(true);
    expect(e['sessionId']).toBeNull();
    expect(e['action']).toBe('grant-read');
    expect(e['path']).toBe('/some/path');
    expect(e['source']).toBe('slash');
    expect(e['timestamp']).toEqual(expect.any(String));
  });

  it('emits sessionId=null when no sessionId is bound (addWriteRoot)', () => {
    const dispatcher = makeDispatcher();
    dispatcher.addWriteRoot('/some/write', 'tool');
    const entries = readAuditEntries();
    const e = entries[entries.length - 1]!;
    expect('sessionId' in e).toBe(true);
    expect(e['sessionId']).toBeNull();
    expect(e['action']).toBe('grant-write');
  });

  it('emits sessionId=null when no sessionId is bound (revokeRoot)', () => {
    const dispatcher = makeDispatcher();
    dispatcher.addReadRoot('/some/path', 'slash');
    dispatcher.revokeRoot('/some/path', 'slash');
    const entries = readAuditEntries();
    const last = entries[entries.length - 1]!;
    expect('sessionId' in last).toBe(true);
    expect(last['sessionId']).toBeNull();
    expect(last['action']).toBe('revoke');
  });

  it('emits literal sessionId string when one is bound', () => {
    const dispatcher = makeDispatcher('session-xyz-789');
    dispatcher.addReadRoot('/another/path', 'slash');
    const entries = readAuditEntries();
    const e = entries[entries.length - 1]!;
    expect(e['sessionId']).toBe('session-xyz-789');
  });

  it('every entry exposes the same canonical key set (schema symmetry)', () => {
    const dispatcher = makeDispatcher();
    dispatcher.addReadRoot('/p1', 'slash');
    dispatcher.addWriteRoot('/p2', 'tool');
    dispatcher.revokeRoot('/p1', 'slash');
    const entries = readAuditEntries();
    expect(entries.length).toBe(3);
    const expectedKeys = ['timestamp', 'sessionId', 'action', 'path', 'source'].sort();
    for (const e of entries) {
      expect(Object.keys(e).sort()).toEqual(expectedKeys);
    }
  });

  // Regression: the audit append must fire only when a root is NEWLY added.
  // Before the dedup fix, addReadRoot/addWriteRoot appended unconditionally, so
  // repeated per-tool-call grants of an already-granted path (e.g. the cwd)
  // ballooned session-grants.jsonl ~196x (1,143 unique grants → 224k rows).
  it('does not re-append when the same read root is granted repeatedly', () => {
    const dispatcher = makeDispatcher();
    dispatcher.addReadRoot('/dup/read', 'tool');
    dispatcher.addReadRoot('/dup/read', 'tool');
    dispatcher.addReadRoot('/dup/read', 'tool');
    const entries = readAuditEntries().filter((e) => e['path'] === '/dup/read');
    expect(entries.length).toBe(1);
    expect(entries[0]!['action']).toBe('grant-read');
  });

  it('does not re-append when the same write root is granted repeatedly', () => {
    const dispatcher = makeDispatcher();
    dispatcher.addWriteRoot('/dup/write', 'tool');
    dispatcher.addWriteRoot('/dup/write', 'tool');
    const entries = readAuditEntries().filter((e) => e['path'] === '/dup/write');
    expect(entries.length).toBe(1);
    expect(entries[0]!['action']).toBe('grant-write');
  });

  it('still audits a read→write upgrade as a new grant-write', () => {
    const dispatcher = makeDispatcher();
    dispatcher.addReadRoot('/upgrade/path', 'tool'); // grant-read (new to readRoots)
    dispatcher.addWriteRoot('/upgrade/path', 'tool'); // grant-write (new to writeRoots)
    dispatcher.addWriteRoot('/upgrade/path', 'tool'); // no-op — already a write root
    const entries = readAuditEntries().filter((e) => e['path'] === '/upgrade/path');
    expect(entries.map((e) => e['action'])).toEqual(['grant-read', 'grant-write']);
  });
});
