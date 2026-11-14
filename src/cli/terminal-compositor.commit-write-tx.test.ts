import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { CommitWriteTx } from './terminal-compositor.commit-write-tx.js';
import { installObserver } from './terminal-compositor.lifecycle.suspend-observer.js';
import { SYNC_START, SYNC_END } from './cup-frame-renderer.escapes.js';

function tty(): NodeJS.WriteStream {
  return Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 }) as unknown as NodeJS.WriteStream;
}

function output(stream: NodeJS.WriteStream): Buffer {
  return (stream as unknown as PassThrough).read() as Buffer;
}

describe('CommitWriteTx', () => {
  it('buffers writes in call order and returns true until the single flush', () => {
    const stream = tty();
    const physical = vi.spyOn(stream, 'write');
    const tx = CommitWriteTx.begin(stream);
    expect(stream.write('a')).toBe(true);
    expect(stream.write('b')).toBe(true);
    expect(stream.write(Buffer.from('c'))).toBe(true);
    expect(output(stream)).toBeNull();
    tx.end();
    expect(physical).toHaveBeenCalledTimes(1);
    expect(output(stream).toString()).toBe(SYNC_START + 'abc' + SYNC_END);
  });

  it('forwards a single captured write byte-identical, without sync framing', () => {
    const stream = tty();
    const physical = vi.spyOn(stream, 'write');
    const own = SYNC_START + 'frame' + SYNC_END;
    const tx = CommitWriteTx.begin(stream);
    stream.write(own);
    tx.end();
    expect(physical).toHaveBeenCalledTimes(1);
    expect(output(stream).toString()).toBe(own);
    const plain = CommitWriteTx.begin(stream);
    stream.write('line\n');
    plain.end();
    expect(output(stream).toString()).toBe('line\n');
  });

  it('preserves encoded strings, arbitrary bytes and split UTF-8 sequences', () => {
    const stream = tty();
    const tx = CommitWriteTx.begin(stream);
    stream.write('e9', 'hex');
    stream.write(Buffer.from([0xff, 0xc3]));
    stream.write(new Uint8Array([0xa9]));
    tx.end();
    expect(output(stream)).toEqual(Buffer.concat([
      Buffer.from(SYNC_START), Buffer.from([0xe9, 0xff, 0xc3, 0xa9]), Buffer.from(SYNC_END),
    ]));
  });

  it('restores the original prototype method without creating an own property', () => {
    const stream = tty();
    const before = stream.write;
    expect(Object.hasOwn(stream, 'write')).toBe(false);
    CommitWriteTx.begin(stream).end();
    expect(Object.hasOwn(stream, 'write')).toBe(false);
    expect(stream.write).toBe(before);
  });

  it('restores an own-property wrapper and its descriptor by identity', () => {
    const stream = tty();
    const forward = stream.write.bind(stream);
    let newlines = 0;
    // Same bound forwarding shape as interactive.pty-setup.ts's pre-arm counter.
    const wrapper: NodeJS.WriteStream['write'] = (chunk, ...rest: unknown[]) => {
      newlines += String(chunk).split('\n').length - 1;
      return Reflect.apply(forward, stream, [chunk, ...rest]) as boolean;
    };
    Object.defineProperty(stream, 'write', { value: wrapper, writable: true, configurable: true });
    const descriptor = Object.getOwnPropertyDescriptor(stream, 'write');
    const tx = CommitWriteTx.begin(stream);
    stream.write('one\ntwo\n');
    tx.end();
    expect(stream.write).toBe(wrapper);
    expect(Object.getOwnPropertyDescriptor(stream, 'write')).toEqual(descriptor);
    expect(newlines).toBe(2);
    stream.write('later\n');
    expect(newlines).toBe(3);
  });

  it('composes with the real suspend observer installed before begin', () => {
    const stream = tty();
    const observer = installObserver(stream, 1, 24, 80);
    const wrapper = stream.write;
    const tx = CommitWriteTx.begin(stream);
    stream.write('owner\n');
    tx.end();
    expect(stream.write).toBe(wrapper);
    expect(observer.remove()).toEqual({ cursorRow: 2, scrollCount: 0 });
    expect(output(stream).toString()).toBe('owner\n');
    stream.write('after');
    expect(output(stream).toString()).toBe('after');
  });

  // Invariant: neither production wrapper can install/remove mid-transaction.
  // Pre-arm measurement finishes before armCompositor (interactive.ts). Suspend
  // installs its observer outside commitAbove; suspended commits only queue, and
  // resume removes it before replay (lifecycle.ts). Commit phases and footer
  // redraws do not call these lifecycle APIs or yield to timers/microtasks.
  // Their restored bound wrappers can remain as own properties, tested above.

  it('completes both write callback overloads after flushing', async () => {
    const stream = tty();
    const fired: string[] = [];
    const tx = CommitWriteTx.begin(stream);
    stream.write('x', () => fired.push('one'));
    stream.write('y', 'utf8', () => fired.push('two'));
    expect(fired).toEqual([]);
    tx.end();
    await new Promise(resolve => setImmediate(resolve));
    expect(fired).toEqual(['one', 'two']);
  });

  it('propagates asynchronous flush errors to every buffered callback', () => {
    const stream = tty();
    const error = new Error('failed');
    stream.write = vi.fn((_chunk, _encoding: unknown, callback: unknown) => {
      (callback as (err: Error) => void)(error);
      return false;
    }) as unknown as NodeJS.WriteStream['write'];
    const callbacks = [vi.fn(), vi.fn()];
    const tx = CommitWriteTx.begin(stream);
    stream.write('x', callbacks[0]);
    stream.write('y', 'utf8', callbacks[1]);
    tx.end();
    for (const callback of callbacks) expect(callback).toHaveBeenCalledExactlyOnceWith(error);
  });

  it('strips inner sync markers even when split across chunks', () => {
    const stream = tty();
    const tx = CommitWriteTx.begin(stream);
    stream.write('pre' + SYNC_START.slice(0, 3));
    stream.write(SYNC_START.slice(3) + 'frame' + SYNC_END + 'post');
    tx.end();
    expect(output(stream).toString()).toBe(SYNC_START + 'preframepost' + SYNC_END);
  });

  it('only flushes after all nested handles end, idempotently', () => {
    const stream = tty();
    const before = stream.write;
    const outer = CommitWriteTx.begin(stream);
    const inner = CommitWriteTx.begin(stream);
    stream.write('a');
    outer.end();
    outer.end();
    expect(output(stream)).toBeNull();
    expect(stream.write).not.toBe(before);
    inner.end();
    inner.end();
    expect(stream.write).toBe(before);
    expect(output(stream).toString()).toBe('a');
  });

  it('is a no-op on non-TTY streams, without sync markers or patching', () => {
    const stream = new PassThrough() as unknown as NodeJS.WriteStream;
    const before = stream.write;
    const tx = CommitWriteTx.begin(stream);
    expect(stream.write).toBe(before);
    stream.write('plain');
    tx.end();
    expect(output(stream).toString()).toBe('plain');
  });

  it('restores and flushes partial bytes when the body throws', () => {
    const stream = tty();
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
    expect(output(stream).toString()).toBe('partial');
  });

  it('restores before a throwing physical flush and permits a later transaction', () => {
    const stream = tty();
    const error = new Error('EPIPE');
    const write = vi.fn(() => { throw error; });
    stream.write = write;
    const callback = vi.fn();
    const tx = CommitWriteTx.begin(stream);
    stream.write('partial', callback);
    expect(() => tx.end()).toThrow(error);
    expect(stream.write).toBe(write);
    expect(callback).toHaveBeenCalledExactlyOnceWith(error);
    expect(() => CommitWriteTx.begin(stream).end()).not.toThrow();
    expect(stream.write).toBe(write);
  });

  it('does not write an empty transaction but still completes empty-write callbacks', async () => {
    const stream = tty();
    const physical = vi.spyOn(stream, 'write');
    const callback = vi.fn();
    const tx = CommitWriteTx.begin(stream);
    stream.write('', callback);
    tx.end();
    await new Promise(resolve => setImmediate(resolve));
    expect(physical).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledExactlyOnceWith(null);
  });
});
