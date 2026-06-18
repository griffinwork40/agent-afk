/**
 * Tests for the AFK remote-control channel auth (per-session HMAC).
 *
 * Uses a temp AFK_HOME per suite run so no real ~/.afk/state is touched
 * (env must be set before importing the path-dependent module).
 */

import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-channel-test-'));
process.env['AFK_HOME'] = tmpDir;

import {
  stableStringify,
  ensureSessionKey,
  readSessionKey,
  signElicitationResponse,
  verifyElicitationResponse,
  signAbortRequest,
  verifyAbortRequest,
  freshChannelId,
} from './afk-channel.js';
import { getSessionKeyPath } from '../paths.js';
import type { ElicitationResult } from './types/sdk-types.js';

let seq = 0;
function freshId(): string {
  return `chan-test-${Date.now()}-${seq++}`;
}

describe('stableStringify', () => {
  it('is insensitive to object key insertion order', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    expect(stableStringify({ x: { p: 1, q: 2 } })).toBe(stableStringify({ x: { q: 2, p: 1 } }));
  });

  it('preserves array order', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
  });
});

describe('session key management', () => {
  it('creates a key on first use and returns the same key thereafter', () => {
    const id = freshId();
    const k1 = ensureSessionKey(id);
    const k2 = ensureSessionKey(id);
    expect(k1).toBeTruthy();
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes the key file with 0600 permissions', () => {
    const id = freshId();
    ensureSessionKey(id);
    const mode = fs.statSync(getSessionKeyPath(id)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('readSessionKey returns null when no key exists, the key once created', () => {
    const id = freshId();
    expect(readSessionKey(id)).toBeNull();
    const created = ensureSessionKey(id);
    expect(readSessionKey(id)).toBe(created);
  });

  it('returns null for an unsafe session id rather than throwing', () => {
    expect(ensureSessionKey('../escape')).toBeNull();
    expect(readSessionKey('../escape')).toBeNull();
  });
});

describe('elicitation response signing', () => {
  const result: ElicitationResult = { action: 'accept', content: { value: 'b' } };

  it('round-trips: a signature verifies for the same key/session/reqId/result', () => {
    const id = freshId();
    const key = ensureSessionKey(id)!;
    const sig = signElicitationResponse(key, id, 'r1', result);
    expect(verifyElicitationResponse(key, id, 'r1', result, sig)).toBe(true);
  });

  it('is insensitive to result key order (stable canonicalization)', () => {
    const id = freshId();
    const key = ensureSessionKey(id)!;
    const sig = signElicitationResponse(key, id, 'r1', {
      action: 'accept',
      content: { value: 'b', extra: 1 },
    });
    const reordered: ElicitationResult = { content: { extra: 1, value: 'b' }, action: 'accept' };
    expect(verifyElicitationResponse(key, id, 'r1', reordered, sig)).toBe(true);
  });

  it('rejects a tampered result', () => {
    const id = freshId();
    const key = ensureSessionKey(id)!;
    const sig = signElicitationResponse(key, id, 'r1', result);
    const tampered: ElicitationResult = { action: 'accept', content: { value: 'EVIL' } };
    expect(verifyElicitationResponse(key, id, 'r1', tampered, sig)).toBe(false);
  });

  it('rejects a wrong reqId, wrong session, and wrong key', () => {
    const id = freshId();
    const key = ensureSessionKey(id)!;
    const sig = signElicitationResponse(key, id, 'r1', result);
    expect(verifyElicitationResponse(key, id, 'r2', result, sig)).toBe(false);
    expect(verifyElicitationResponse(key, 'other-session', 'r1', result, sig)).toBe(false);
    expect(verifyElicitationResponse('00'.repeat(32), id, 'r1', result, sig)).toBe(false);
  });

  it('rejects a malformed signature without throwing', () => {
    const id = freshId();
    const key = ensureSessionKey(id)!;
    expect(verifyElicitationResponse(key, id, 'r1', result, 'not-hex!!')).toBe(false);
    expect(verifyElicitationResponse(key, id, 'r1', result, '')).toBe(false);
  });
});

describe('abort request signing', () => {
  it('round-trips and rejects tampering', () => {
    const id = freshId();
    const key = ensureSessionKey(id)!;
    const nonce = freshChannelId();
    const sig = signAbortRequest(key, id, nonce);
    expect(verifyAbortRequest(key, id, nonce, sig)).toBe(true);
    expect(verifyAbortRequest(key, id, 'other-nonce', sig)).toBe(false);
    expect(verifyAbortRequest('11'.repeat(32), id, nonce, sig)).toBe(false);
  });

  it('a response signature does not verify as an abort (kind-bound canonical)', () => {
    const id = freshId();
    const key = ensureSessionKey(id)!;
    const respSig = signElicitationResponse(key, id, 'r1', { action: 'accept' });
    expect(verifyAbortRequest(key, id, 'r1', respSig)).toBe(false);
  });
});

describe('freshChannelId', () => {
  it('returns distinct 16-hex-char ids', () => {
    const a = freshChannelId();
    const b = freshChannelId();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });
});
