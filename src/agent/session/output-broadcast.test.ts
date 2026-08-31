import { describe, it, expect } from 'vitest';
import { OutputBroadcast } from './output-broadcast.js';
import type { OutputEvent } from '../types/session-types.js';

function makeEvent(type: string, text = ''): OutputEvent {
  return { type, text } as unknown as OutputEvent;
}

describe('OutputBroadcast', () => {
  it('delivers pushed events to a subscriber', async () => {
    const bc = new OutputBroadcast();
    const stream = bc.subscribe();
    const iter = stream[Symbol.asyncIterator]();

    bc.push(makeEvent('chunk', 'hello'));
    const { value, done } = await iter.next();
    expect(done).toBe(false);
    expect((value as { text: string }).text).toBe('hello');
  });

  it('buffers events pushed before pull', async () => {
    const bc = new OutputBroadcast();
    const stream = bc.subscribe();
    const iter = stream[Symbol.asyncIterator]();

    bc.push(makeEvent('chunk', 'a'));
    bc.push(makeEvent('chunk', 'b'));

    const r1 = await iter.next();
    const r2 = await iter.next();
    expect((r1.value as { text: string }).text).toBe('a');
    expect((r2.value as { text: string }).text).toBe('b');
  });

  it('resolves pending pull when event is pushed', async () => {
    const bc = new OutputBroadcast();
    const stream = bc.subscribe();
    const iter = stream[Symbol.asyncIterator]();

    // Start pull before push — it parks.
    const pending = iter.next();
    bc.push(makeEvent('chunk', 'delayed'));
    const { value } = await pending;
    expect((value as { text: string }).text).toBe('delayed');
  });

  it('close signals done to waiting subscriber', async () => {
    const bc = new OutputBroadcast();
    const stream = bc.subscribe();
    const iter = stream[Symbol.asyncIterator]();

    const pending = iter.next();
    bc.close();
    const { done } = await pending;
    expect(done).toBe(true);
  });

  it('close signals done after buffer is drained', async () => {
    const bc = new OutputBroadcast();
    const stream = bc.subscribe();
    const iter = stream[Symbol.asyncIterator]();

    bc.push(makeEvent('chunk', 'last'));
    bc.close();

    const r1 = await iter.next();
    expect(r1.done).toBe(false);
    expect((r1.value as { text: string }).text).toBe('last');

    const r2 = await iter.next();
    expect(r2.done).toBe(true);
  });

  it('supports multiple concurrent subscribers', async () => {
    const bc = new OutputBroadcast();
    const s1 = bc.subscribe()[Symbol.asyncIterator]();
    const s2 = bc.subscribe()[Symbol.asyncIterator]();

    bc.push(makeEvent('chunk', 'shared'));

    const r1 = await s1.next();
    const r2 = await s2.next();
    expect((r1.value as { text: string }).text).toBe('shared');
    expect((r2.value as { text: string }).text).toBe('shared');
  });

  it('return() cleans up the subscriber', async () => {
    const bc = new OutputBroadcast();
    const stream = bc.subscribe();
    const iter = stream[Symbol.asyncIterator]();

    await iter.return?.();
    // After return, subsequent pushes should not accumulate.
    bc.push(makeEvent('chunk', 'orphan'));
    bc.close();
  });
});
