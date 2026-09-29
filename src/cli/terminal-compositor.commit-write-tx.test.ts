import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { CommitWriteTx, type TxStream } from './terminal-compositor.commit-write-tx.js';
import { SYNC_START, SYNC_END } from './cup-frame-renderer.escapes.js';

/** Paused-mode PassThrough posing as a TTY: `read()` returns what was flushed. */
function tty(): { stream: TxStream } {
  const stream = new PassThrough() as unknown as TxStream;
  (stream as unknown as { isTTY: boolean }).isTTY = true;
  return { stream };
}

describe('CommitWriteTx', () => {
  it('delivers every write of a transaction as one sync-wrapped write, in order', () => {
    const { stream } = tty();
    const tx = CommitWriteTx.begin(stream);
    stream.write('a');
    stream.write('b');
    stream.write(Buffer.from('c'));
    expect(stream.read(), 'nothing reaches the stream mid-transaction').toBeNull();
    tx.end();
    expect((stream.read() as Buffer).toString()).toBe(SYNC_START + 'abc' + SYNC_END);
  });

  it('restores the original write by identity (prototype method shows through again)', () => {
    const { stream } = tty();
    const before = stream.write;
    expect(Object.prototype.hasOwnProperty.call(stream, 'write')).toBe(false);
    CommitWriteTx.begin(stream).end();
    expect(Object.prototype.hasOwnProperty.call(stream, 'write')).toBe(false);
    expect(stream.write).toBe(before);
  });

  it('restores an own-property write by identity', () => {
    const { stream } = tty();
    const own = function ownWrite(this: TxStream, ...a: unknown[]): boolean {
      return (PassThrough.prototype.write as (...x: unknown[]) => boolean).apply(this, a);
    };
    (stream as unknown as Record<string, unknown>)['write'] = own;
    CommitWriteTx.begin(stream).end();
    expect(stream.write).toBe(own);
  });

  it('fires callbacks passed during the transaction once the flush completes', async () => {
    const { stream } = tty();
    const fired: string[] = [];
    const tx = CommitWriteTx.begin(stream);
    stream.write('x', () => fired.push('one'));
    stream.write('y', 'utf8', () => fired.push('two'));
    expect(fired).toEqual([]);
    tx.end();
    stream.read();
    await new Promise((r) => setImmediate(r));
    expect(fired).toEqual(['one', 'two']);
  });

  it('strips nested sync markers so exactly one sync pair wraps the commit', () => {
    const { stream } = tty();
    const tx = CommitWriteTx.begin(stream);
    stream.write('pre');
    stream.write(SYNC_START + 'frame' + SYNC_END);
    stream.write('post');
    tx.end();
    const s = (stream.read() as Buffer).toString();
    expect(s).toBe(SYNC_START + 'preframepost' + SYNC_END);
  });

  it('only the outermost end() flushes; the stream stays patched until then', () => {
    const { stream } = tty();
    const before = stream.write;
    const outer = CommitWriteTx.begin(stream);
    const inner = CommitWriteTx.begin(stream);
    stream.write('a');
    inner.end();
    inner.end();
    expect(stream.read()).toBeNull();
    expect(stream.write).not.toBe(before);
    outer.end();
    expect(stream.write).toBe(before);
    expect((stream.read() as Buffer).toString()).toBe(SYNC_START + 'a' + SYNC_END);
  });

  it('is a no-op on non-TTY streams', () => {
    const stream = new PassThrough() as unknown as TxStream;
    const before = stream.write;
    const tx = CommitWriteTx.begin(stream);
    expect(stream.write).toBe(before);
    stream.write('plain');
    tx.end();
    expect((stream.read() as Buffer).toString()).toBe('plain');
  });

  it('restores the stream even when the commit body throws', () => {
    const { stream } = tty();
    const before = stream.write;
    expect(() => {
      const tx = CommitWriteTx.begin(stream);
      try {
        stream.write('partial');
        throw new Error('boom');
      } finally {
        tx.end();
      }
    }).toThrow('boom');
    expect(stream.write).toBe(before);
    expect((stream.read() as Buffer).toString()).toBe(SYNC_START + 'partial' + SYNC_END);
  });
});
