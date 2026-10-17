/**
 * Tests for session-manager.disk-io helpers.
 *
 * Covers:
 *   - encodeRouteFilename / decodeRouteFilename round-trip
 *   - sidecarFileName produces Windows-safe names for topic routes
 *   - loadSessionsFromDisk loads both legacy colon-named and new tilde-named files
 *   - saveSessionsToDisk writes tilde-named files for topic routes
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  encodeRouteFilename,
  decodeRouteFilename,
  sidecarFileName,
  loadSessionsFromDisk,
  saveSessionsToDisk,
} from './session-manager.disk-io.js';
import type { SessionData } from './session-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'afk-disk-io-test-'));
}

function makeSessionData(chatId: number, threadId?: number): SessionData {
  const ts = new Date().toISOString();
  const data: SessionData = {
    chatId,
    model: 'claude-sonnet-4-5',
    createdAt: ts,
    lastActivity: ts,
  };
  if (threadId !== undefined) data.threadId = threadId;
  return data;
}

// ---------------------------------------------------------------------------
// encodeRouteFilename / decodeRouteFilename
// ---------------------------------------------------------------------------

describe('encodeRouteFilename', () => {
  it('leaves General (chatId-only) keys unchanged', () => {
    expect(encodeRouteFilename('900')).toBe('900');
    expect(encodeRouteFilename('-1001234567890')).toBe('-1001234567890');
  });

  it('replaces the colon separator with tilde for topic routes', () => {
    expect(encodeRouteFilename('900:7')).toBe('900~7');
    expect(encodeRouteFilename('12345:42')).toBe('12345~42');
  });

  it('produces a filename with no colon (Windows-safe)', () => {
    const encoded = encodeRouteFilename('900:7');
    expect(encoded).not.toContain(':');
  });
});

describe('decodeRouteFilename', () => {
  it('reverses encodeRouteFilename for topic routes', () => {
    expect(decodeRouteFilename('900~7')).toBe('900:7');
    expect(decodeRouteFilename('12345~42')).toBe('12345:42');
  });

  it('leaves General (no separator) stems unchanged', () => {
    expect(decodeRouteFilename('900')).toBe('900');
  });

  it('passes through legacy colon-named stems unchanged', () => {
    // Legacy POSIX files written before the fix still contain `:`.
    // decodeRouteFilename must not corrupt them — they are already valid routeKeys.
    expect(decodeRouteFilename('900:7')).toBe('900:7');
  });
});

// ---------------------------------------------------------------------------
// sidecarFileName
// ---------------------------------------------------------------------------

describe('sidecarFileName', () => {
  it('returns <chatId>.json for General routes (no threadId)', () => {
    const data = makeSessionData(900);
    expect(sidecarFileName(data)).toBe('900.json');
  });

  it('returns <chatId>~<threadId>.json for topic routes (Windows-safe)', () => {
    const data = makeSessionData(900, 7);
    expect(sidecarFileName(data)).toBe('900~7.json');
  });

  it('never contains a colon', () => {
    expect(sidecarFileName(makeSessionData(900, 7))).not.toContain(':');
    expect(sidecarFileName(makeSessionData(-1001234567890, 99))).not.toContain(':');
  });
});

// ---------------------------------------------------------------------------
// loadSessionsFromDisk — new tilde-named files
// ---------------------------------------------------------------------------

describe('loadSessionsFromDisk', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = makeTmpDir();
  });

  it('loads a General sidecar (<chatId>.json)', async () => {
    const data = makeSessionData(900);
    fs.writeFileSync(path.join(dataDir, '900.json'), JSON.stringify(data));

    const sessionData = new Map<string, SessionData>();
    const routes: Array<{ chatId: number; threadId?: number }> = [];
    await loadSessionsFromDisk(dataDir, sessionData, (route) => routes.push(route));

    expect(sessionData.has('900')).toBe(true);
    expect(routes).toHaveLength(1);
    expect(routes[0]!.chatId).toBe(900);
    expect(routes[0]!.threadId).toBeUndefined();
  });

  it('loads a new-style tilde-named topic sidecar (<chatId>~<threadId>.json)', async () => {
    const data = makeSessionData(900, 7);
    fs.writeFileSync(path.join(dataDir, '900~7.json'), JSON.stringify(data));

    const sessionData = new Map<string, SessionData>();
    await loadSessionsFromDisk(dataDir, sessionData, () => {});

    // In-memory key is routeKey form: chatId:threadId
    expect(sessionData.has('900:7')).toBe(true);
    expect(sessionData.get('900:7')!.threadId).toBe(7);
  });

  it('loads legacy colon-named topic sidecar (<chatId>:<threadId>.json) — POSIX back-compat', async () => {
    // Files written by old code on POSIX still use `:` in the filename.
    // Colons are illegal in Windows filenames so such files cannot be created
    // on Windows — but the loadSessionsFromDisk logic is tested portably here
    // by directly injecting payload-derived routing without relying on the
    // filename, which is exactly what the loader does.
    const data = makeSessionData(900, 7);

    // Gate: the colon-named file must survive a FULL filesystem round-trip —
    // write, read-back, AND appear in readdirSync.  On NTFS, writeFileSync
    // and readFileSync both succeed (they silently create/read an Alternate
    // Data Stream), but readdirSync never lists the ADS entry.  Since
    // loadSessionsFromDisk discovers files via readdir, a file invisible to
    // readdir is unreachable by the loader and untestable here.
    const colonName = '900:7.json';
    const colonPath = path.join(dataDir, colonName);
    let colonVisibleToReaddir = false;
    try {
      fs.writeFileSync(colonPath, JSON.stringify(data));
      const readBack = fs.readFileSync(colonPath, 'utf-8');
      JSON.parse(readBack); // must be valid JSON with actual content
      // The decisive check: readdir must list the exact colon-named entry.
      const entries = fs.readdirSync(dataDir);
      colonVisibleToReaddir = entries.includes(colonName);
    } catch {
      // OS rejected the colon filename outright — nothing to test.
    }

    if (colonVisibleToReaddir) {
      const sessionData = new Map<string, SessionData>();
      await loadSessionsFromDisk(dataDir, sessionData, () => {});
      // Key derived from JSON payload, not filename — must be chatId:threadId.
      expect(sessionData.has('900:7')).toBe(true);
    }

    // Portable assertion: the loader always derives its key from the JSON
    // payload regardless of filename encoding. Simulate this directly.
    const sessionData2 = new Map<string, SessionData>();
    const routes: Array<{ chatId: number; threadId?: number }> = [];
    // Write a tilde-named file (the new encoding) and confirm the same key.
    fs.writeFileSync(path.join(dataDir, '900~7.json'), JSON.stringify(data));
    await loadSessionsFromDisk(dataDir, sessionData2, (r) => routes.push(r));
    expect(sessionData2.has('900:7')).toBe(true);
    expect(sessionData2.get('900:7')!.threadId).toBe(7);
  });

  it('ignores non-.json files', async () => {
    fs.writeFileSync(path.join(dataDir, 'README.txt'), 'ignore me');
    const data = makeSessionData(42);
    fs.writeFileSync(path.join(dataDir, '42.json'), JSON.stringify(data));

    const sessionData = new Map<string, SessionData>();
    await loadSessionsFromDisk(dataDir, sessionData, () => {});
    expect(sessionData.size).toBe(1);
  });

  it('handles a missing directory gracefully (no throw)', async () => {
    const missing = path.join(dataDir, 'does-not-exist');
    const sessionData = new Map<string, SessionData>();
    await expect(loadSessionsFromDisk(missing, sessionData, () => {})).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// saveSessionsToDisk — writes tilde-named files
// ---------------------------------------------------------------------------

describe('saveSessionsToDisk', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = makeTmpDir();
  });

  it('writes <chatId>.json for General sessions', async () => {
    const data = makeSessionData(900);
    const sessionData = new Map([['900', data]]);
    await saveSessionsToDisk(dataDir, sessionData);

    expect(fs.existsSync(path.join(dataDir, '900.json'))).toBe(true);
  });

  it('writes <chatId>~<threadId>.json for topic sessions (no colon on disk)', async () => {
    const data = makeSessionData(900, 7);
    const sessionData = new Map([['900:7', data]]);
    await saveSessionsToDisk(dataDir, sessionData);

    expect(fs.existsSync(path.join(dataDir, '900~7.json'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, '900:7.json'))).toBe(false);
  });

  it('round-trips through save → load', async () => {
    const general = makeSessionData(900);
    const topic = makeSessionData(900, 7);
    const sessionData = new Map<string, SessionData>([
      ['900', general],
      ['900:7', topic],
    ]);
    await saveSessionsToDisk(dataDir, sessionData);

    const loaded = new Map<string, SessionData>();
    await loadSessionsFromDisk(dataDir, loaded, () => {});

    expect(loaded.has('900')).toBe(true);
    expect(loaded.has('900:7')).toBe(true);
    expect(loaded.get('900:7')!.threadId).toBe(7);
  });

  it('removes the legacy colon-named file after saving a topic route', async () => {
    // Simulate a pre-upgrade POSIX install that has a legacy colon file.
    const data = makeSessionData(700, 9);
    let wroteColonFile = false;
    try {
      fs.writeFileSync(path.join(dataDir, '700:9.json'), JSON.stringify(data));
      wroteColonFile = true;
    } catch {
      // Windows: colon filenames are OS-rejected; cleanup path is untestable
      // here, but the save itself must still succeed.
    }

    const sessionData = new Map([['700:9', data]]);
    await saveSessionsToDisk(dataDir, sessionData);

    // The canonical tilde file must always be written.
    expect(fs.existsSync(path.join(dataDir, '700~9.json'))).toBe(true);

    if (wroteColonFile) {
      // On POSIX: the legacy file must have been removed.
      expect(fs.existsSync(path.join(dataDir, '700:9.json'))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// loadSessionsFromDisk — both filename forms present: encoded (tilde) wins
// ---------------------------------------------------------------------------

describe('loadSessionsFromDisk — determinism when both filename forms exist', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = makeTmpDir();
  });

  it('prefers the tilde-named file over the legacy colon-named file', async () => {
    // Stale data in the legacy colon file, fresh data in the tilde file.
    // Use sessionId as the distinguishing field (present in SessionData).
    const staleData = makeSessionData(300, 4);
    staleData.sessionId = 'stale-session';
    const freshData = makeSessionData(300, 4);
    freshData.sessionId = 'fresh-session';

    let wroteColonFile = false;
    try {
      fs.writeFileSync(path.join(dataDir, '300:4.json'), JSON.stringify(staleData));
      wroteColonFile = true;
    } catch {
      // Windows: cannot write colon-named file.
    }
    fs.writeFileSync(path.join(dataDir, '300~4.json'), JSON.stringify(freshData));

    const sessionData = new Map<string, SessionData>();
    await loadSessionsFromDisk(dataDir, sessionData, () => {});

    expect(sessionData.has('300:4')).toBe(true);
    // Both platforms: the tilde (canonical) file must win.
    expect(sessionData.get('300:4')!.sessionId).toBe('fresh-session');
    if (wroteColonFile) {
      expect(sessionData.get('300:4')!.sessionId).not.toBe('stale-session');
    }
  });
});
