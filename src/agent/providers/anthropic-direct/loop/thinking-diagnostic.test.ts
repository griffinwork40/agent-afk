// Coverage for the extended-thinking rejection diagnostic. Previously an
// unexported, untested function at the tail of loop.ts. Its whole value is
// being TOTAL — it runs on an error path, so a throw here would mask the real
// API failure it exists to explain.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MessageParam } from '@anthropic-ai/sdk/resources';
import { dumpThinkingDiagnostic } from './thinking-diagnostic.js';

describe('dumpThinkingDiagnostic', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  const logged = (): string => errSpy.mock.calls.map((c) => c.join(' ')).join('\n');

  it('names the message and block index of a thinking block missing its signature', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'thinking', thinking: 'reasoning...', signature: '' },
        ] as never,
      },
    ];

    dumpThinkingDiagnostic(messages, new Error('400 invalid thinking block'));

    const out = logged();
    expect(out).toContain('400 invalid thinking block');
    expect(out).toContain('"msgIdx":1');
    expect(out).toContain('"blockIdx":1');
    expect(out).toContain('messages.length=2');
  });

  it('flags a thinking block with an empty body', () => {
    const messages: MessageParam[] = [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '', signature: 'sig' }] as never,
      },
    ];

    dumpThinkingDiagnostic(messages, new Error('boom'));

    expect(logged()).toContain('(empty)');
  });

  it('reports "none found" when every thinking block is well-formed', () => {
    const messages: MessageParam[] = [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'reasoned', signature: 'sig' }] as never,
      },
    ];

    dumpThinkingDiagnostic(messages, new Error('unrelated 400'));

    expect(logged()).toContain('none found');
  });

  it('ignores user turns and string-content assistant turns', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'plain string' },
      { role: 'assistant', content: 'also a plain string' },
    ];

    dumpThinkingDiagnostic(messages, new Error('x'));

    expect(logged()).toContain('none found');
  });

  it('never throws, even on structurally malformed history', () => {
    const hostile = [null, { role: 'assistant' }, 42] as unknown as MessageParam[];

    expect(() => dumpThinkingDiagnostic(hostile, new Error('x'))).not.toThrow();
  });
});
