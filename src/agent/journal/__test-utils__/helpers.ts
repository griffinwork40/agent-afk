// Test-only helpers for the journal suites (not exported from index.ts).
import * as fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';

import type { JournalMessage } from '../types.js';

/** Fresh AFK_HOME per test (the global setup gives one per FILE). */
export function useTmpAfkHome(): { home: () => string } {
  let dir = '';
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env['AFK_HOME']; // audit-env-access: allow — test isolation
    dir = mkdtempSync(join(tmpdir(), 'afk-journal-test-'));
    process.env['AFK_HOME'] = dir; // audit-env-access: allow — test isolation
  });
  afterEach(() => {
    if (prev === undefined) delete process.env['AFK_HOME']; // audit-env-access: allow — test isolation
    else process.env['AFK_HOME'] = prev; // audit-env-access: allow — test isolation
    rmSync(dir, { recursive: true, force: true });
  });
  return { home: () => dir };
}

export const user = (text: string): JournalMessage => ({ role: 'user', content: [{ type: 'text', text }] });
export const assistant = (text: string): JournalMessage => ({ role: 'assistant', content: [{ type: 'text', text }] });

export function toolResult(toolUseId: string, text: string): JournalMessage {
  return { role: 'user', content: [{ type: 'tool_result', toolUseId, content: [{ type: 'text', text }] }] };
}

export function readLines(path: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
