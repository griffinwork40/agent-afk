import { join } from 'node:path';
import { getSessionsDir, validateSessionId } from '../../paths.js';
import { detectSecrets } from '../../global-chat/secret-detect.js';
import { debugLog } from '../../utils/debug.js';
import { readJsonFileLoose } from '../../utils/json-file.js';
import { readRecord } from '../outcomes/store.js';
import { extractUserContent, isPreamble } from '../session/preamble-strip.js';
import { redactInlineSecrets } from '../session/prompt-dump.js';
import { readSessionMeta } from '../session/session-meta.js';
import type { FacetFtsStore } from './facet-fts-store.js';

// 16 Ki UTF-16 units per session: 12 Ki for user turns, 1.5 Ki for metadata,
// with the remainder covering the pre-existing summary fields. Share the
// turn budget evenly so a large opening prompt cannot crowd out follow-ups.
const USER_TEXT_CAP = 12 * 1024;
const METADATA_CAP = 1536;
const TURN_CAP = 2048;
const CWD_CAP = 512;

export interface FacetIndexFields {
  session_id: string;
  brief_summary: string;
  underlying_goal: string;
  primary_success: string;
  decisions: string;
  start_time?: string;
  cwd?: string;
  extra_text?: string;
}

export interface FacetIndexSource {
  sidecarId: string;
  cwd?: string;
  backfill?: boolean;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

// Scrub before truncating so a credential straddling a cap is still detected.
// Omit a field/turn entirely if a known credential remains after inline
// redaction (including a PEM header, whose key body is not a detected span).
function scrub(value: string, cap: number): string {
  const redacted = redactInlineSecrets(value);
  return detectSecrets(redacted).length ? '' : redacted.trim().slice(0, cap);
}

function userText(sidecar: Record<string, unknown> | undefined): string {
  const turns = sidecar?.['turns'];
  if (!Array.isArray(turns)) return '';
  // Reserve room for recent follow-ups even in sessions with thousands of turns.
  const messages = turns.map((turn) => {
    const raw = text(object(turn)?.['user']);
    return isPreamble(raw) ? extractUserContent(raw) : raw;
  }).filter(Boolean).slice(-256);
  if (!messages.length) return '';
  const allowance = Math.min(TURN_CAP, Math.floor(USER_TEXT_CAP / messages.length) - 1);
  return messages.map((message) => scrub(message ?? '', allowance)).filter(Boolean).join('\n');
}

function readSidecar(sidecarId: string): Record<string, unknown> | undefined {
  try {
    validateSessionId(sidecarId);
    return object(readJsonFileLoose<unknown>(join(getSessionsDir(), `${sidecarId}.json`)));
  } catch {
    return undefined;
  }
}

function storedOutcomes(sessionId: string) {
  try {
    // Use the structured result if the existing asynchronous outcome pass
    // has already persisted it. Never run git or parse raw tool output here.
    return readRecord(sessionId)?.outcomes;
  } catch {
    return undefined;
  }
}

function sessionStart(value: unknown, fallback: unknown): string | undefined {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  const date = new Date(Number.isFinite(ms) ? ms : typeof fallback === 'number' ? fallback : NaN);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : undefined;
}

/** Shared projection for live writes and schema rebuilds; only these fields can enter search. */
export function indexFacetIntoStore(store: FacetFtsStore, raw: unknown, source?: FacetIndexSource): void {
  try {
    const facet = object(raw);
    const sessionId = text(facet?.['session_id']).trim();
    if (!facet || !sessionId || (source?.backfill && store.isIndexed(sessionId))) return;
    const sidecar = source && readSidecar(source.sidecarId);
    const meta = source && readSessionMeta(sessionId);
    const outcomes = source && sidecar && storedOutcomes(sessionId);
    const cwd = scrub(source?.cwd || text(sidecar?.['cwd']) || text(meta?.cwd), CWD_CAP);
    const metadata = [
      text(meta?.gitHead?.branch),
      text(object(facet['yield_tracking'])?.['pr_url']),
      ...(outcomes?.prs.map((pr) => pr.url) ?? []),
      ...(outcomes?.commits.map((commit) => commit.subject) ?? []),
      ...strings(facet['evidence_pointers']).filter((path) => path !== facet['source_session_path']),
      ...(outcomes?.filesChanged ?? []),
    ];
    const metadataText = [...new Set(metadata.map((value) => scrub(value, METADATA_CAP)).filter(Boolean))]
      .join('\n').slice(0, METADATA_CAP);
    const decisions = facet['decisions'];
    store.indexFacet({
      session_id: sessionId,
      brief_summary: scrub(text(facet['brief_summary']), 400),
      underlying_goal: scrub(text(facet['underlying_goal']), 1000),
      primary_success: scrub(text(facet['primary_success']), 160),
      decisions: scrub(Array.isArray(decisions) ? strings(decisions).join(' ') : text(decisions), 384),
      start_time: sessionStart(facet['start_time'], sidecar?.['startedAt'] ?? meta?.startedAt),
      cwd,
      extra_text: [metadataText, userText(sidecar)].filter(Boolean).join('\n'),
    }, source?.backfill);
  } catch (err) {
    debugLog('facet-fts-store: facet projection failed (non-fatal):', String(err));
  }
}
