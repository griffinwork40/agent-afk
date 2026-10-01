import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  buildQuery,
  discoverTerminalColors,
  getTerminalColors,
  parseColorSpec,
  parseReplies,
  queryTerminalColors,
  setTerminalColors,
  type QueryInput,
} from './terminal-colors.js';

const ESC = '\u001b';
const ST = `${ESC}\\`;
const BEL = '\u0007';
const DA1_REPLY = `${ESC}[?62;22c`;

/** A fake raw-mode TTY stdin that records what the query does to it. */
class FakeTty extends EventEmitter implements QueryInput {
  isTTY = true;
  isRaw = false;
  paused = true;
  rawCalls: boolean[] = [];
  unshifted: string[] = [];
  setRawMode(mode: boolean): this { this.isRaw = mode; this.rawCalls.push(mode); return this; }
  resume(): this { this.paused = false; return this; }
  pause(): this { this.paused = true; return this; }
  isPaused(): boolean { return this.paused; }
  unshift(chunk: Buffer | string): void { this.unshifted.push(String(chunk)); }
}

function fakeOut(onWrite: (s: string) => void = () => {}): { isTTY: boolean; written: string[]; write(s: string): boolean } {
  const written: string[] = [];
  return { isTTY: true, written, write(s: string) { written.push(s); onWrite(s); return true; } };
}

afterEach(() => {
  setTerminalColors(null);
  vi.useRealTimers();
});

describe('parseColorSpec', () => {
  it('scales 1-4 hex digits per channel and accepts #RRGGBB', () => {
    expect(parseColorSpec('rgb:8a8a/8a8a/8a8a')).toEqual([138, 138, 138]);
    expect(parseColorSpec('rgb:ff/00/80')).toEqual([255, 0, 128]);
    expect(parseColorSpec('rgb:f/0/8')).toEqual([255, 0, 136]);
    expect(parseColorSpec('rgb:fff/000/800')).toEqual([255, 0, 128]);
    expect(parseColorSpec('#19120D')).toEqual([25, 18, 13]);
    expect(parseColorSpec('rgba:ffff/ffff/ffff/ffff')).toEqual([255, 255, 255]);
    expect(parseColorSpec('nonsense')).toBeNull();
  });
});

describe('parseReplies', () => {
  it('reads fg, bg, and palette replies with BEL or ST terminators, and the DA1 sentinel', () => {
    const input =
      `${ESC}]10;rgb:8a8a/8a8a/8a8a${ST}${ESC}]11;rgb:0000/0000/0000${BEL}` +
      `${ESC}]4;6;rgb:3333/bbbb/c8c8${ST}${DA1_REPLY}`;
    const r = parseReplies(input);
    expect(r.colors.fg).toEqual([138, 138, 138]);
    expect(r.colors.bg).toEqual([0, 0, 0]);
    expect(r.colors.palette.get(6)).toEqual([51, 187, 200]);
    expect(r.done).toBe(true);
    expect(r.rest).toBe('');
  });

  it('keeps unrelated bytes (typeahead) in rest', () => {
    const r = parseReplies(`hi${ESC}]11;rgb:0/0/0${ST}!`);
    expect(r.done).toBe(false);
    expect(r.rest).toBe('hi!');
  });
});

describe('queryTerminalColors', () => {
  it('sends fg, bg, 16 palette queries, and DA1 last', () => {
    const q = buildQuery();
    expect(q.startsWith(`${ESC}]10;?${ST}${ESC}]11;?${ST}`)).toBe(true);
    expect(q.match(/\u001b\]4;\d+;\?/g)).toHaveLength(16);
    expect(q.endsWith(`${ESC}[c`)).toBe(true);
  });

  it('resolves on the DA1 reply even when it arrives split, then restores the stream', async () => {
    const tty = new FakeTty();
    const out = fakeOut(() => {
      setImmediate(() => {
        tty.emit('data', Buffer.from(`${ESC}]10;rgb:8a8a/8a8a/8a8a${ST}${ESC}]11;rgb:00`));
        tty.emit('data', Buffer.from(`00/0000/0000${ST}${ESC}[?62`));
        tty.emit('data', Buffer.from(';22c'));
      });
    });
    const colors = await queryTerminalColors({ input: tty, output: out, timeoutMs: 5000 });
    expect(colors?.fg).toEqual([138, 138, 138]);
    expect(colors?.bg).toEqual([0, 0, 0]);
    expect(tty.rawCalls).toEqual([true, false]);
    expect(tty.isRaw).toBe(false);
    expect(tty.paused).toBe(true);
    expect(tty.listenerCount('data')).toBe(0);
    expect(tty.unshifted).toEqual([]);
  });

  it('finishes fast on a terminal that ignores OSC (DA1 only) and resolves null', async () => {
    const tty = new FakeTty();
    const out = fakeOut(() => setImmediate(() => tty.emit('data', DA1_REPLY)));
    await expect(queryTerminalColors({ input: tty, output: out, timeoutMs: 5000 })).resolves.toBeNull();
    expect(tty.listenerCount('data')).toBe(0);
  });

  it('gives up at the timeout when nothing answers', async () => {
    vi.useFakeTimers();
    const tty = new FakeTty();
    const p = queryTerminalColors({ input: tty, output: fakeOut(), timeoutMs: 150 });
    await vi.advanceTimersByTimeAsync(151);
    await expect(p).resolves.toBeNull();
    expect(tty.listenerCount('data')).toBe(0);
    expect(tty.isRaw).toBe(false);
  });

  it('hands typeahead back to stdin instead of swallowing it', async () => {
    const tty = new FakeTty();
    const out = fakeOut(() => setImmediate(() => tty.emit('data', `ls${ESC}]11;rgb:0/0/0${ST}${DA1_REPLY}`)));
    await queryTerminalColors({ input: tty, output: out, timeoutMs: 5000 });
    expect(tty.unshifted).toEqual(['ls']);
  });

  it('preserves an already-raw, flowing stream', async () => {
    const tty = new FakeTty();
    tty.isRaw = true;
    tty.paused = false;
    const out = fakeOut(() => setImmediate(() => tty.emit('data', DA1_REPLY)));
    await queryTerminalColors({ input: tty, output: out, timeoutMs: 5000 });
    expect(tty.isRaw).toBe(true);
    expect(tty.paused).toBe(false);
  });

  it('never touches a non-TTY', async () => {
    const tty = new FakeTty();
    tty.isTTY = false;
    const out = fakeOut();
    await expect(queryTerminalColors({ input: tty, output: out })).resolves.toBeNull();
    expect(out.written).toEqual([]);
    expect(tty.rawCalls).toEqual([]);
  });
});

describe('discoverTerminalColors', () => {
  it('caches what the terminal reported', async () => {
    const tty = new FakeTty();
    const out = fakeOut(() => setImmediate(() => tty.emit('data', `${ESC}]10;rgb:8a/8a/8a${ST}${DA1_REPLY}`)));
    await discoverTerminalColors(true, { input: tty, output: out, timeoutMs: 5000 });
    expect(getTerminalColors()?.fg).toEqual([138, 138, 138]);
  });

  it('does nothing when disabled', async () => {
    const tty = new FakeTty();
    const out = fakeOut();
    await discoverTerminalColors(false, { input: tty, output: out });
    expect(out.written).toEqual([]);
    expect(getTerminalColors()).toBeNull();
  });
});
