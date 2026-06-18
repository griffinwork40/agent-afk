/**
 * AFK remote-control channel: per-session HMAC authentication for the
 * cross-process elicitation/abort protocol carried over the session ledger.
 *
 * Invariant: records that drive the autonomous agent from another process —
 * `elicitation_response` (an answer) and `abort_request` (a kill) — MUST be
 * authenticated. The REPL session writes a random per-session key to
 * `~/.afk/state/sessions/<id>/session.key` (0600) when it enters AFK mode; the
 * Telegram daemon reads that key to sign any response/abort it writes back into
 * the ledger, and the REPL verifies the signature before acting. A stray,
 * buggy, or cross-session write therefore cannot resolve a question or abort a
 * turn.
 *
 * Threat boundary (honest): this binds the channel against ACCIDENTAL
 * cross-session bleed and stray writers. It is NOT a defense against a malicious
 * SAME-USER process — that process can read the 0600 key, and it already holds
 * the user's privileges. The Telegram ingress stays gated by the
 * AFK_TELEGRAM_ALLOWED_CHAT_IDS allowlist; this layer protects the on-disk hop.
 *
 * Contract: the signed canonical form binds (recordKind, sessionId, correlator,
 * payload) so a signature is valid only for one record kind, one session, and
 * one request/nonce — replaying a response under a different reqId or session
 * fails verification.
 *
 * @module agent/afk-channel
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getSessionKeyPath } from '../paths.js';
import type { ElicitationResult } from './types/sdk-types.js';

/** Per-session key length. 32 bytes (256 bits) → 64 hex chars. */
const KEY_BYTES = 32;
/** Field separator for canonical signing input — NUL can't appear in our fields. */
const SEP = '\u0000';

/**
 * Deterministic JSON: object keys sorted recursively so the HMAC input is
 * stable regardless of property insertion order. Arrays keep their order.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = sortValue(src[key]);
    return out;
  }
  return value;
}

/**
 * Read the per-session channel key, creating it if absent. Idempotent: the
 * first caller writes a fresh random key (0600); later callers read the same
 * bytes. Returns null only when the key can neither be read nor written (e.g.
 * an invalid session id or an unwritable state dir) — callers treat null as
 * "channel auth unavailable" and degrade (the keyboard fallback still works).
 */
export function ensureSessionKey(sessionId: string): string | null {
  const existing = readSessionKey(sessionId);
  if (existing) return existing;
  let keyPath: string;
  try {
    keyPath = getSessionKeyPath(sessionId);
  } catch {
    return null;
  }
  try {
    // The per-session dir may not exist yet (the ledger writer creates it
    // lazily on first record); create it so the key write doesn't ENOENT.
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    const key = randomBytes(KEY_BYTES).toString('hex');
    fs.writeFileSync(keyPath, key + '\n', { mode: 0o600 });
    return key;
  } catch {
    // Possible concurrent create — try one more read before giving up.
    return readSessionKey(sessionId);
  }
}

/** Read an existing per-session channel key (daemon side). Null if absent. */
export function readSessionKey(sessionId: string): string | null {
  let keyPath: string;
  try {
    keyPath = getSessionKeyPath(sessionId);
  } catch {
    return null;
  }
  try {
    const key = fs.readFileSync(keyPath, 'utf8').trim();
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

function hmac(key: string, canonical: string): string {
  return createHmac('sha256', key).update(canonical).digest('hex');
}

/** Timing-safe comparison of two hex digests. False on any length/parse mismatch. */
function digestsEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) {
    return false;
  }
  let bufA: Buffer;
  let bufB: Buffer;
  try {
    bufA = Buffer.from(a, 'hex');
    bufB = Buffer.from(b, 'hex');
  } catch {
    return false;
  }
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// elicitation_response
// ---------------------------------------------------------------------------

function responseCanonical(sessionId: string, reqId: string, result: ElicitationResult): string {
  return ['elicitation_response', sessionId, reqId, stableStringify(result)].join(SEP);
}

/** Sign an elicitation response (daemon side, before writing it back). */
export function signElicitationResponse(
  key: string,
  sessionId: string,
  reqId: string,
  result: ElicitationResult,
): string {
  return hmac(key, responseCanonical(sessionId, reqId, result));
}

/** Verify an elicitation response (REPL side, before resolving the question). */
export function verifyElicitationResponse(
  key: string,
  sessionId: string,
  reqId: string,
  result: ElicitationResult,
  sig: string,
): boolean {
  return digestsEqual(sig, signElicitationResponse(key, sessionId, reqId, result));
}

// ---------------------------------------------------------------------------
// abort_request
// ---------------------------------------------------------------------------

function abortCanonical(sessionId: string, nonce: string): string {
  return ['abort_request', sessionId, nonce].join(SEP);
}

/** Sign an abort request (daemon side). */
export function signAbortRequest(key: string, sessionId: string, nonce: string): string {
  return hmac(key, abortCanonical(sessionId, nonce));
}

/** Verify an abort request (REPL side, before firing the AbortGraph). */
export function verifyAbortRequest(
  key: string,
  sessionId: string,
  nonce: string,
  sig: string,
): boolean {
  return digestsEqual(sig, signAbortRequest(key, sessionId, nonce));
}

/** Fresh random correlation id / nonce for channel records (hex). */
export function freshChannelId(): string {
  return randomBytes(8).toString('hex');
}
