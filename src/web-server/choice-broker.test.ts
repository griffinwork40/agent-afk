import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChoiceBroker } from './choice-broker.js';
import type { ChoiceRequest } from './shared/choice-wire.js';

const request: ChoiceRequest = {
  corrId: 'request-1', title: 'Pick one', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
  cancellable: true,
};
afterEach(() => { vi.useRealTimers(); });

describe('ChoiceBroker', () => {
  it('delivers to every tab; only one valid answer wins, and dismisses peers', async () => {
    const broker = new ChoiceBroker();
    const a = vi.fn(); const b = vi.fn();
    broker.subscribe('session', a);
    broker.subscribe('session', b);
    const answer = broker.choose('session', request);
    expect(a).toHaveBeenCalledWith({ type: 'choice_request', request });
    expect(b).toHaveBeenCalledWith({ type: 'choice_request', request });
    expect(broker.answer('session', 'request-1', 'bad')).toBe('invalid_value');
    expect(broker.answer('other', 'request-1', 'a')).toBe('wrong_session');
    expect(broker.answer('session', 'request-1', 'b')).toBe('answered');
    expect(broker.answer('session', 'request-1', 'a')).toBe('unknown');
    expect(await answer).toBe('b');
    expect(a).toHaveBeenCalledWith({ type: 'choice_settled', corrId: 'request-1' });
    expect(b).toHaveBeenCalledWith({ type: 'choice_settled', corrId: 'request-1' });
  });

  it('rejects null when cancellation is disabled; unknown ids cannot settle', async () => {
    const broker = new ChoiceBroker();
    expect(broker.answer('session', 'missing', 'a')).toBe('unknown');
    const answer = broker.choose('session', { ...request, cancellable: false });
    expect(broker.answer('session', 'request-1', null)).toBe('invalid_value');
    expect(broker.answer('session', 'request-1', 'a')).toBe('answered');
    expect(await answer).toBe('a');
  });

  it('times out, removes the request and allows a later reuse of its id', async () => {
    vi.useFakeTimers();
    const broker = new ChoiceBroker(100);
    const answer = broker.choose('s', request);
    await vi.advanceTimersByTimeAsync(100);
    expect(await answer).toBeNull();
    expect(broker.answer('s', request.corrId, 'a')).toBe('unknown');
    const again = broker.choose('s', request);
    broker.cancelSession('s');
    expect(await again).toBeNull();
  });

  it('cancels only target session on last SSE disconnect and replays pending on reconnection', async () => {
    const broker = new ChoiceBroker();
    const first = vi.fn(); const second = vi.fn();
    const detachA = broker.subscribe('a', first);
    const detachB = broker.subscribe('a', second);
    const a = broker.choose('a', request);
    const b = broker.choose('b', { ...request, corrId: 'request-2' });
    detachA();
    expect(broker.answer('a', request.corrId, 'a')).toBe('answered');
    expect(await a).toBe('a');
    const c = broker.choose('a', { ...request, corrId: 'request-3' });
    detachB();
    expect(await c).toBeNull();
    expect(broker.answer('b', 'request-2', 'b')).toBe('answered');
    expect(await b).toBe('b');
    const pending = broker.choose('new', request);
    const third = vi.fn();
    broker.subscribe('new', third);
    expect(third).toHaveBeenCalledWith({ type: 'choice_request', request });
    broker.cancelAll();
    expect(await pending).toBeNull();
    const fresh = broker.choose('a', { ...request, corrId: 'request-4' });
    expect(broker.answer('a', 'request-4', 'b')).toBe('answered');
    expect(await fresh).toBe('b');
  });

  it('settles on command abort and never broadcasts another session progress', async () => {
    const broker = new ChoiceBroker();
    const a = vi.fn(); const b = vi.fn();
    broker.subscribe('a', a); broker.subscribe('b', b);
    const controller = new AbortController();
    const result = broker.choose('a', request, controller.signal);
    broker.progress('a', { corrId: 'progress', phase: 'update', label: 'Working', fraction: .5 });
    expect(a).toHaveBeenCalledWith({ type: 'progress', corrId: 'progress', phase: 'update', label: 'Working', fraction: .5 });
    expect(b).not.toHaveBeenCalled();
    controller.abort();
    expect(await result).toBeNull();
    expect(broker.answer('a', request.corrId, 'a')).toBe('unknown');
  });

  it('isolates throwing subscribers during request, progress and settlement', async () => {
    const broker = new ChoiceBroker();
    const broken = vi.fn(() => { throw new Error('closed SSE transport'); });
    const healthy = vi.fn();
    broker.subscribe('s', broken);
    broker.subscribe('s', healthy);
    const answer = broker.choose('s', request);
    // Attach rejection handling immediately: transport failures must not reject choose.
    const result = answer.then((value) => ({ value }), (error: unknown) => ({ error }));
    expect(healthy).toHaveBeenCalledWith({ type: 'choice_request', request });
    expect(() => broker.progress('s', { corrId: 'p', phase: 'end', label: 'Done' })).not.toThrow();
    expect(healthy).toHaveBeenCalledWith({ type: 'progress', corrId: 'p', phase: 'end', label: 'Done' });
    expect(() => broker.answer('s', request.corrId, 'a')).not.toThrow();
    expect(await result).toEqual({ value: 'a' });
    expect(healthy).toHaveBeenCalledWith({ type: 'choice_settled', corrId: request.corrId });
    expect(broken).toHaveBeenCalledTimes(3);
  });

  it('isolates snapshot listener failures and still returns a working unsubscribe', async () => {
    const broker = new ChoiceBroker();
    const answer = broker.choose('s', request);
    const broken = vi.fn(() => { throw new Error('snapshot failed'); });
    let unsubscribe: (() => void) | undefined;
    expect(() => { unsubscribe = broker.subscribe('s', broken); }).not.toThrow();
    expect(broken).toHaveBeenCalledWith({ type: 'choice_request', request });
    unsubscribe?.();
    expect(await answer).toBeNull();
    expect(broker.answer('s', request.corrId, 'a')).toBe('unknown');
  });

  it('settles every pending promise despite throwing listeners during cancellation', async () => {
    const broker = new ChoiceBroker();
    broker.subscribe('s', () => { throw new Error('broken'); });
    const first = broker.choose('s', request);
    const second = broker.choose('s', { ...request, corrId: 'second' });
    const results = Promise.allSettled([first, second]);
    expect(() => broker.cancelAll()).not.toThrow();
    expect(await results).toEqual([
      { status: 'fulfilled', value: null }, { status: 'fulfilled', value: null },
    ]);
  });

  it('refuses duplicate ids (including across sessions) and duplicate option values', async () => {
    const broker = new ChoiceBroker();
    const pending = broker.choose('a', request);
    expect(() => broker.choose('b', request)).toThrow(/duplicate/);
    expect(() => broker.choose('a', { ...request, corrId: 'other', options: [request.options[0]!, request.options[0]!] })).toThrow(/unique/);
    broker.cancelAll();
    expect(await pending).toBeNull();
  });
});
