/**
 * Tests for `src/whatif/episodes.ts`.
 *
 * Uses a tmp directory for the session ledger; no real ~/.afk access.
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectRealTurns,
  loadSuiteEpisodes,
  syntheticEpisodes,
} from './episodes.js';
import type { Prediction } from './types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePred(id: string, probes: string[]): Prediction {
  return {
    id,
    behavior: 'test',
    direction: 'strengthened',
    confidence: 'medium',
    reason: 'reason',
    testQuestion: 'Does X?',
    probes,
  };
}

function ledgerLine(kind: string, text: string): string {
  return JSON.stringify({ v: 1, ts: Date.now(), kind, text }) + '\n';
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'whatif-ep-test-'));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// syntheticEpisodes
// ---------------------------------------------------------------------------

describe('syntheticEpisodes', () => {
  it('returns empty array for no predictions', () => {
    expect(syntheticEpisodes([])).toEqual([]);
  });

  it('creates one episode per probe', () => {
    const eps = syntheticEpisodes([makePred('p1', ['probe A', 'probe B'])]);
    expect(eps.length).toBe(2);
    expect(eps[0]!.id).toBe('s1');
    expect(eps[1]!.id).toBe('s2');
    expect(eps[0]!.targets).toBe('p1');
    expect(eps[0]!.prompt).toBe('probe A');
    expect(eps[0]!.source).toBe('synthetic');
  });

  it('ids continue across multiple predictions', () => {
    const eps = syntheticEpisodes([
      makePred('p1', ['a']),
      makePred('p2', ['b', 'c']),
    ]);
    expect(eps.map((e) => e.id)).toEqual(['s1', 's2', 's3']);
  });
});

// ---------------------------------------------------------------------------
// collectRealTurns
// ---------------------------------------------------------------------------

describe('collectRealTurns', () => {
  async function writeSession(sessionId: string, lines: string[]): Promise<void> {
    const sessDir = path.join(tmpDir, sessionId);
    await fsp.mkdir(sessDir, { recursive: true });
    await fsp.writeFile(path.join(sessDir, 'events.jsonl'), lines.join(''), 'utf8');
  }

  it('returns empty array when sessionsDir is empty', async () => {
    const eps = await collectRealTurns({ limit: 10, sessionsDir: tmpDir });
    expect(eps).toEqual([]);
  });

  it('collects user turns', async () => {
    await writeSession('sess1', [
      ledgerLine('user', 'What is the capital of France?'),
    ]);
    const eps = await collectRealTurns({ limit: 10, sessionsDir: tmpDir });
    expect(eps.length).toBe(1);
    expect(eps[0]!.source).toBe('real');
    expect(eps[0]!.prompt).toContain('France');
  });

  it('skips short prompts (< 15 chars)', async () => {
    await writeSession('sess1', [ledgerLine('user', 'hi')]);
    const eps = await collectRealTurns({ limit: 10, sessionsDir: tmpDir });
    expect(eps).toEqual([]);
  });

  it('skips prompts starting with /', async () => {
    await writeSession('sess1', [ledgerLine('user', '/whatif do something interesting here')]);
    const eps = await collectRealTurns({ limit: 10, sessionsDir: tmpDir });
    expect(eps).toEqual([]);
  });

  it('skips prompts with disqualifying content', async () => {
    await writeSession('sess1', [
      ledgerLine('user', '<bash-passthrough>ls -la</bash-passthrough> Some extra text here'),
    ]);
    const eps = await collectRealTurns({ limit: 10, sessionsDir: tmpDir });
    expect(eps).toEqual([]);
  });

  it('deduplicates case-insensitively', async () => {
    await writeSession('sess1', [
      ledgerLine('user', 'What is the capital of France?'),
      ledgerLine('user', 'what is the capital of france?'),
    ]);
    const eps = await collectRealTurns({ limit: 10, sessionsDir: tmpDir });
    expect(eps.length).toBe(1);
  });

  it('respects limit', async () => {
    await writeSession('sess1', [
      ledgerLine('user', 'First question — please answer this one for me'),
      ledgerLine('user', 'Second question — please also answer this for me'),
      ledgerLine('user', 'Third question — please answer this third thing'),
    ]);
    const eps = await collectRealTurns({ limit: 2, sessionsDir: tmpDir });
    expect(eps.length).toBe(2);
  });

  it('excludes specified session ids', async () => {
    await writeSession('sess-exclude', [
      ledgerLine('user', 'What is the capital of France?'),
    ]);
    const eps = await collectRealTurns({
      limit: 10,
      sessionsDir: tmpDir,
      excludeSessionIds: ['sess-exclude'],
    });
    expect(eps).toEqual([]);
  });

  it('assigns sequential r-prefixed ids', async () => {
    await writeSession('sess1', [
      ledgerLine('user', 'First unique question that is long enough to pass'),
      ledgerLine('user', 'Second unique question that is also long enough'),
    ]);
    const eps = await collectRealTurns({ limit: 10, sessionsDir: tmpDir });
    expect(eps.map((e) => e.id)).toEqual(['r1', 'r2']);
  });

  it('skips non-user records', async () => {
    await writeSession('sess1', [
      ledgerLine('assistant', 'This is an assistant message that should be ignored'),
      ledgerLine('user', 'This is a valid user message that is long enough'),
    ]);
    const eps = await collectRealTurns({ limit: 10, sessionsDir: tmpDir });
    expect(eps.length).toBe(1);
    expect(eps[0]!.prompt).toContain('valid user message');
  });
});

// ---------------------------------------------------------------------------
// loadSuiteEpisodes
// ---------------------------------------------------------------------------

describe('loadSuiteEpisodes', () => {
  it('returns empty array for missing directory', async () => {
    const eps = await loadSuiteEpisodes(path.join(tmpDir, 'nonexistent'));
    expect(eps).toEqual([]);
  });

  it('loads episodes from a JSON file', async () => {
    const suiteDir = path.join(tmpDir, 'suites');
    await fsp.mkdir(suiteDir, { recursive: true });
    await fsp.writeFile(
      path.join(suiteDir, 'my-suite.json'),
      JSON.stringify({ episodes: [{ prompt: 'Hello, agent!' }, { prompt: 'Fix this bug.' }] }),
      'utf8',
    );
    const eps = await loadSuiteEpisodes(suiteDir);
    expect(eps.length).toBe(2);
    expect(eps[0]!.id).toBe('u1');
    expect(eps[0]!.source).toBe('suite');
    expect(eps[0]!.prompt).toBe('Hello, agent!');
  });

  it('skips invalid JSON files with a warning', async () => {
    const suiteDir = path.join(tmpDir, 'suites');
    await fsp.mkdir(suiteDir, { recursive: true });
    await fsp.writeFile(path.join(suiteDir, 'bad.json'), 'not json', 'utf8');
    await fsp.writeFile(
      path.join(suiteDir, 'good.json'),
      JSON.stringify({ episodes: [{ prompt: 'Good prompt here.' }] }),
      'utf8',
    );
    const eps = await loadSuiteEpisodes(suiteDir);
    // Only the good file's episode should appear.
    expect(eps.length).toBe(1);
    expect(eps[0]!.prompt).toBe('Good prompt here.');
  });

  it('ids are sequential across multiple files', async () => {
    const suiteDir = path.join(tmpDir, 'suites');
    await fsp.mkdir(suiteDir, { recursive: true });
    // Files are sorted alphabetically.
    await fsp.writeFile(
      path.join(suiteDir, 'a.json'),
      JSON.stringify({ episodes: [{ prompt: 'First.' }] }),
      'utf8',
    );
    await fsp.writeFile(
      path.join(suiteDir, 'b.json'),
      JSON.stringify({ episodes: [{ prompt: 'Second.' }] }),
      'utf8',
    );
    const eps = await loadSuiteEpisodes(suiteDir);
    expect(eps.map((e) => e.id)).toEqual(['u1', 'u2']);
  });

  it('skips entries without a string prompt', async () => {
    const suiteDir = path.join(tmpDir, 'suites');
    await fsp.mkdir(suiteDir, { recursive: true });
    await fsp.writeFile(
      path.join(suiteDir, 'mixed.json'),
      JSON.stringify({ episodes: [{ prompt: 'Good.' }, { no_prompt: true }, { prompt: 42 }] }),
      'utf8',
    );
    const eps = await loadSuiteEpisodes(suiteDir);
    expect(eps.length).toBe(1);
  });
});
