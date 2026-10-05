// The no-clobber guarantee of forkJournal must not depend on its existsSync
// early-out: a destination created after that check must never be replaced.
import * as fs from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const race = vi.hoisted(() => ({ blindPath: undefined as string | undefined }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const existsSync = (p: fs.PathLike): boolean => (String(p) === race.blindPath ? false : real.existsSync(p));
  return { ...real, default: { ...real, existsSync }, existsSync };
});

import { getSessionJournalPath } from '../../paths.js';
import { useTmpAfkHome, user } from './__test-utils__/helpers.js';
import { forkJournal } from './fork.js';
import { createMessageJournal } from './writer.js';

useTmpAfkHome();

describe('forkJournal destination race', () => {
  it('returns false and leaves a concurrently created destination untouched', async () => {
    const j = createMessageJournal({ getSessionId: () => 'race-src' });
    j.append(0, user('a'));
    await j.close();

    const dst = getSessionJournalPath('race-dst');
    fs.mkdirSync(dirname(dst), { recursive: true });
    fs.writeFileSync(dst, 'LIVE\n');
    race.blindPath = dst; // simulate the dst appearing after the existsSync check
    try {
      expect(forkJournal('race-src', 'race-dst')).toBe(false);
    } finally {
      race.blindPath = undefined;
    }
    expect(fs.readFileSync(dst, 'utf8')).toBe('LIVE\n');
    expect(fs.readdirSync(dirname(dst)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
