import { describe, expect, it } from 'vitest';
import { parseClientFrame, parseRelayFrame } from './protocol.parse.js';
import { BACKLOG_SIZE, ERROR_CODES, MAX_CLIENT_FRAME_BYTES, MAX_RELAY_FRAME_BYTES } from './protocol.js';

const pubkey = 'ab'.repeat(32);
const id = 'cd'.repeat(16);
const sig = 'ef'.repeat(64);
const signed = { id, ts: 123, sig };
const m = { ...signed, pubkey, name: 'alice', text: 'hi' };
const hello = { t: 'hello', v: 1, pubkey, name: 'alice', ts: 123, sig };
const clientFrames = [hello, { t: 'post', ...signed, text: 'hi' },
  { t: 'report', ...signed, target: id }, { t: 'admin', ...signed, op: 'mode', arg: 'open' }, { t: 'ping', n: 1 }];
const welcome = { t: 'welcome', online: 1, mode: 'open', backlog: [m], you: { pubkey, name: 'alice' } };
const relayFrames = [welcome, { t: 'msg', m }, { t: 'presence', online: 0 }, { t: 'deleted', id },
  { t: 'mode', mode: 'readonly' }, { t: 'ack', id }, { t: 'error', code: 'bad_frame', message: 'bad' }, { t: 'pong', n: 2 }];

describe('frame parsers', () => {
  it.each(clientFrames)('accepts client frame $t and drops extras', frame => {
    expect(parseClientFrame(JSON.stringify({ ...frame, extra: 1 }))).toEqual({ ok: true, frame });
  });
  it.each(relayFrames)('accepts relay frame $t and drops extras', frame => {
    expect(parseRelayFrame(JSON.stringify({ ...frame, extra: 1 }))).toEqual({ ok: true, frame });
  });
  it('accepts all admin ops and relay modes', () => {
    for (const op of ['ban', 'unban', 'delete', 'mode']) {
      expect(parseClientFrame(JSON.stringify({ t: 'admin', ...signed, op, arg: 'value' })).ok).toBe(true);
    }
    for (const mode of ['open', 'readonly', 'closed']) {
      expect(parseRelayFrame(JSON.stringify({ t: 'mode', mode })).ok).toBe(true);
    }
    for (const code of ERROR_CODES) {
      expect(parseRelayFrame(JSON.stringify({ t: 'error', code, message: 'bad', id, retryAfterMs: 1 })).ok).toBe(true);
    }
  });
  it('preserves optional fields and ignores nested extras', () => {
    const frame = { ...welcome, notice: 'hello', backlog: [{ ...m, badge: 'maintainer' }],
      you: { pubkey, name: 'alice', badge: 'maintainer' } };
    expect(parseRelayFrame(JSON.stringify({ ...frame, you: { ...frame.you, extra: 1 } })))
      .toEqual({ ok: true, frame });
  });
  it.each(['', '{', 'null', 'true', '[]', '42', '"str"', '{"t":"unknown"}', '{"t":"ping"}'])
    ('never throws on bad shape %s', raw => {
      for (const parse of [parseClientFrame, parseRelayFrame]) {
        expect(parse(raw)).toMatchObject({ ok: false, error: { code: 'bad_frame' } });
      }
    });
  it('enforces direction', () => {
    for (const frame of clientFrames) expect(parseRelayFrame(JSON.stringify(frame)).ok).toBe(false);
    for (const frame of relayFrames) expect(parseClientFrame(JSON.stringify(frame)).ok).toBe(false);
  });
  it.each([
    { v: 2 }, { pubkey: pubkey.toUpperCase() }, { pubkey: pubkey + '\n' }, { pubkey: 'a'.repeat(63) },
    { sig: sig.slice(1) }, { sig: sig + '\n' }, { ts: 1.5 }, { ts: -1 }, { ts: '123' },
    { ts: Number.MAX_SAFE_INTEGER + 1 }, { name: null },
  ])('rejects invalid hello fields %j', change => {
    expect(parseClientFrame(JSON.stringify({ ...hello, ...change })).ok).toBe(false);
  });
  it.each([
    { t: 'post', ...signed, text: false }, { t: 'post', ...signed, id: 'x', text: 'hi' },
    { t: 'report', ...signed, target: pubkey }, { t: 'admin', ...signed, op: 'kick', arg: 'hi' },
    { t: 'admin', ...signed, op: 'ban', arg: 1 }, { t: 'ping', n: -1 }, { t: 'ping', n: 1.2 },
  ])('rejects invalid client fields %j', frame => expect(parseClientFrame(JSON.stringify(frame)).ok).toBe(false));
  it.each([
    { ...welcome, online: -1 }, { ...welcome, mode: 'weird' }, { ...welcome, you: null },
    { ...welcome, notice: 2 }, { ...welcome, backlog: [null] }, { ...welcome, backlog: Array(51).fill(m) },
    { ...welcome, you: { pubkey: 'bad', name: 'alice' } },
    { ...welcome, you: { pubkey, name: 1 } }, { ...welcome, you: { pubkey, name: 'alice', badge: 'admin' } },
    { t: 'msg', m: { ...m, badge: 'admin' } }, { t: 'msg', m: { ...m, text: 1 } },
    { t: 'presence', online: '1' }, { t: 'ack', id: pubkey }, { t: 'mode', mode: 'weird' },
    { t: 'error', code: 'unknown', message: 'bad' }, { t: 'error', code: 'banned', message: 1 },
    { t: 'error', code: 'banned', message: 'bad', id: 'bad' },
    { t: 'error', code: 'banned', message: 'bad', retryAfterMs: -1 }, { t: 'pong', n: null },
  ])('rejects invalid relay fields %j', frame => expect(parseRelayFrame(JSON.stringify(frame)).ok).toBe(false));
  it('enforces byte rather than character caps at the boundary', () => {
    const base = JSON.stringify({ t: 'ping', n: 0 });
    const exact = base + ' '.repeat(MAX_CLIENT_FRAME_BYTES - base.length);
    expect(parseClientFrame(exact).ok).toBe(true);
    expect(parseClientFrame(exact + ' ').ok).toBe(false);
    expect(parseRelayFrame(' '.repeat(MAX_RELAY_FRAME_BYTES + 1)).ok).toBe(false);
    expect(parseClientFrame(JSON.stringify({ t: 'post', ...signed, text: '🎉'.repeat(1000) })).ok).toBe(false);
  });
  it('accepts a welcome carrying a full backlog of maximum-size messages', () => {
    // 500 three-byte characters is the largest text the length cap allows in UTF-8.
    const big = { ...signed, pubkey: 'a'.repeat(64), name: 'n'.repeat(16), text: '\u4e2d'.repeat(500) };
    const welcome = JSON.stringify({
      t: 'welcome', online: 9, mode: 'open', you: { pubkey: 'a'.repeat(64), name: 'me' },
      backlog: Array.from({ length: BACKLOG_SIZE }, () => big),
    });
    expect(new TextEncoder().encode(welcome).length).toBeGreaterThan(MAX_CLIENT_FRAME_BYTES);
    expect(new TextEncoder().encode(welcome).length).toBeLessThan(MAX_RELAY_FRAME_BYTES);
    expect(parseRelayFrame(welcome).ok).toBe(true);
  });
  it('does not enforce business policy before signature verification', () => {
    expect(parseClientFrame(JSON.stringify({ ...hello, name: 'admin' })).ok).toBe(true);
    expect(parseClientFrame(JSON.stringify({ t: 'post', ...signed, text: 'a'.repeat(501) })).ok).toBe(true);
  });
  it('rejects arbitrary JSON samples without throwing', () => {
    for (let i = 0; i < 200; i++) {
      const raw = String.fromCodePoint(i).repeat(i % 17);
      expect(() => parseClientFrame(raw)).not.toThrow();
      expect(() => parseRelayFrame(raw)).not.toThrow();
    }
  });
});
