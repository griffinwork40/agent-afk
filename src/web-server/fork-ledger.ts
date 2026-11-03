/**
 * Seed a web fork's display ledger from its copied message journal.
 *
 * Contract: the dashboard renders a session from `sessions/<id>/events.jsonl`.
 * A web `/fork` gets a new id whose journal is copied (forkJournal) but which
 * has no ledger yet, so without this the fork opens blank and at $0, as if
 * the conversation were lost, even though the model has the full history.
 * This writes `meta` plus the projected visible turns (the same projection
 * `/rewind` uses) BEFORE the fork session starts; the session's own ledger
 * writer then appends after it.
 *
 * Best-effort and non-destructive: it never overwrites an existing ledger,
 * and any failure leaves the fork working with an empty view.
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getSessionLedgerDir, getSessionLedgerPath } from '../paths.js';
import { hydrateMessages, loadDisplayMessages } from '../agent/journal/index.js';
import { projectJournalMessages } from './session-owner.projection.js';
import type { LedgerPayload } from '../agent/session-ledger.js';
import { writeSessionMeta } from '../agent/session/session-meta.js';

export function seedForkLedger(forkId: string, meta: { model: string; cwd?: string; forkedFrom?: string }): boolean {
  try {
    const path = getSessionLedgerPath(forkId);
    if (existsSync(path)) return false;
    const messages = hydrateMessages(loadDisplayMessages(forkId));
    if (messages.length === 0) return false;
    const records: LedgerPayload[] = [
      { kind: 'meta', sessionId: forkId, model: meta.model, ...(meta.cwd ? { cwd: meta.cwd } : {}) },
      ...projectJournalMessages(messages),
    ];
    mkdirSync(getSessionLedgerDir(forkId), { recursive: true });
    const temporary = `${path}.${randomUUID()}.fork`;
    const now = Date.now();
    writeFileSync(temporary, records.map((r) => JSON.stringify({ v: 1, ts: now, ...r })).join('\n') + '\n', { mode: 0o600 });
    renameSync(temporary, path);
    // Write the identity sidecar for the fork session (#4429). Best-effort:
    // fire-and-forget so a sidecar failure never breaks the fork flow.
    void writeSessionMeta({
      v: 1,
      sessionId: forkId,
      model: meta.model,
      ...(meta.cwd !== undefined ? { cwd: meta.cwd } : {}),
      ...(meta.forkedFrom !== undefined ? { forkedFrom: meta.forkedFrom } : {}),
    });
    return true;
  } catch {
    return false;
  }
}
