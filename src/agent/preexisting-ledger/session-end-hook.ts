/**
 * SessionEnd hook that scans the completed session's assistant turns for
 * pre-existing-defect flags and appends matching entries to the durable
 * preexisting ledger at getAgentFrameworkDir()/preexisting-ledger.jsonl.
 *
 * Design:
 *   - Mirrors src/agent/facets/session-end-hook.ts in structure.
 *   - Skips subagent sessions (parentSessionId present).
 *   - Skips when sessionId is absent.
 *   - Reads assistant text via loadStoredSession.
 *   - Caps scanned text per turn via MAX_SCAN_CHARS in detector.
 *   - Deduplicates loci within a session before writing.
 *   - Appends JSONL lines with appendFileSync (one call per session end).
 *   - Never throws; never blocks teardown.
 *   - Failures logged via debugLog with prefix [preexisting-ledger].
 *   - Opt-out: AFK_PREEXISTING_LEDGER_DISABLE=1.
 *
 * Ledger: getAgentFrameworkDir()/preexisting-ledger.jsonl alongside
 *   forge-telemetry.jsonl and routing-decisions.jsonl.
 *
 * Repo field: context.cwd (sync, correct for REPL and daemon).
 *
 * @module agent/preexisting-ledger/session-end-hook
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HookHandler } from '../hooks.js';
import { isSubagentContext } from '../hooks/hook-utils.js';
import { loadStoredSession } from '../facets/store.js';
import { getSessionsDir } from '../../paths.js';
import { getPreexistingLedgerPath } from './paths.js';
import { env } from '../../config/env.js';
import { debugLog } from '../../utils/debug.js';
import { detectInText } from './detector.js';
import type { DetectedEntry } from './detector.js';

const LOG_PREFIX = '[preexisting-ledger]';

export interface LedgerRecord {
  ts: string;
  sessionId: string;
  turn: number;
  repo: string;
  signal: DetectedEntry['signal'];
  category: DetectedEntry['category'];
  loci: string[];
}

export function createPreexistingLedgerHook(): HookHandler {
  return (context) => {
    if (context.event !== 'SessionEnd') return {};
    if (env.AFK_PREEXISTING_LEDGER_DISABLE === '1') return {};
    if (isSubagentContext(context)) return {};
    const sessionId = context.sessionId;
    if (!sessionId) return {};
    try {
      const texts = resolveAssistantTexts(sessionId, context.assistantTexts);
      if (texts) runLedgerWrite(sessionId, context.cwd ?? '', texts);
    } catch (err) {
      debugLog(`${LOG_PREFIX} unhandled error during session-end hook:`, String(err));
    }
    return {};
  };
}

function dedupeRecords(records: LedgerRecord[]): LedgerRecord[] {
  const seen = new Set<string>();
  const out: LedgerRecord[] = [];
  for (const rec of records) {
    const key = `${rec.signal}:${[...rec.loci].sort().join(',')}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(rec);
    }
  }
  return out;
}

/**
 * Prefer the in-memory assistant texts threaded on the SessionEnd context:
 * one-shot `afk chat`, daemon, and web sessions never write a sidecar, so a
 * sidecar-only read records nothing for them. Fall back to the sidecar for
 * callers that do not thread texts (older call sites, tests).
 */
export function resolveAssistantTexts(
  sessionId: string,
  fromContext: readonly string[] | undefined,
): readonly string[] | undefined {
  if (fromContext && fromContext.length > 0) return fromContext;
  const session = loadStoredSession(sessionId, getSessionsDir());
  if (!session) {
    debugLog(`${LOG_PREFIX} no in-memory turns and no session sidecar: ${sessionId}`);
    return undefined;
  }
  return session.turns.map((t) => t.assistant ?? '');
}

function runLedgerWrite(sessionId: string, cwd: string, texts: readonly string[]): void {
  const ts = new Date().toISOString();
  const repo = cwd || '';
  const records: LedgerRecord[] = [];
  for (let i = 0; i < texts.length; i++) {
    const assistantText = texts[i] ?? '';
    if (!assistantText) continue;
    const entries = detectInText(assistantText);
    for (const entry of entries) {
      records.push({ ts, sessionId, turn: i, repo, signal: entry.signal, category: entry.category, loci: entry.loci });
    }
  }
  if (records.length === 0) return;
  const deduped = dedupeRecords(records);
  if (deduped.length === 0) return;
  const ledgerPath = getPreexistingLedgerPath();
  try {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    const lines = deduped.map((r) => JSON.stringify(r)).join('\n') + '\n';
    appendFileSync(ledgerPath, lines, 'utf8');
  } catch (err) {
    debugLog(`${LOG_PREFIX} failed to append to ledger ${ledgerPath}: ${String(err)}`);
  }
}
