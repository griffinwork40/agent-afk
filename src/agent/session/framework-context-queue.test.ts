/**
 * Tests for the framework-context queue on AgentSession.
 *
 * Hook-generated context (SubagentStop `injectContext`) must ride along with
 * the NEXT real outbound user message — prepended to it — rather than being
 * pushed as a standalone input-stream message. The provider consumes exactly
 * one input-stream message per turn, so a standalone push becomes its own
 * model turn and displaces the user's next real message by one queue position
 * (every later send is then answered by the message before it). These tests
 * pin the ride-along contract end to end: provider payload, conversation
 * history, drain-once semantics, and the getInputStreamRef channel.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { AgentConfig } from '../types.js';
import type { ProviderUserTurn } from '../provider.js';
import { createMockProvider } from '../__fixtures__/mock-provider.js';

vi.mock('../../utils/debug.js', () => ({
  debugLog: vi.fn(),
}));

import { AgentSession } from '../session.js';

const NUDGE = '[framework-generated context: test nudge]\n\nConsider verifying.';

async function drain(stream: AsyncIterableIterator<unknown>): Promise<void> {
  for await (const _event of stream) {
    // consume all events
  }
}

describe('AgentSession framework-context queue', () => {
  let config: AgentConfig;
  let capturedTurns: ProviderUserTurn[];

  beforeEach(() => {
    capturedTurns = [];
    config = {
      model: 'sonnet',
      maxTurns: 10,
      apiKey: 'test-key',
      provider: createMockProvider({ onTurn: (turn) => capturedTurns.push(turn) }),
    };
  });

  it('prepends queued context to the next string message — one turn, not two', async () => {
    const session = new AgentSession(config);
    session.queueFrameworkContext(NUDGE);

    await drain(session.sendMessageStream('/resolve'));

    expect(capturedTurns).toHaveLength(1);
    expect(capturedTurns[0]!.content).toBe(`${NUDGE}\n\n/resolve`);
    await session.close();
  });

  it('drains the queue once — the following send is unprefixed', async () => {
    const session = new AgentSession(config);
    session.queueFrameworkContext(NUDGE);

    await drain(session.sendMessageStream('first'));
    await drain(session.sendMessageStream('second'));

    expect(capturedTurns).toHaveLength(2);
    expect(capturedTurns[1]!.content).toBe('second');
    await session.close();
  });

  it('joins multiple queued contexts FIFO with blank-line separators', async () => {
    const session = new AgentSession(config);
    session.queueFrameworkContext('note one');
    session.queueFrameworkContext('note two');

    await drain(session.sendMessageStream('go'));

    expect(capturedTurns[0]!.content).toBe('note one\n\nnote two\n\ngo');
    await session.close();
  });

  it('prepends a text block when the outbound content is ContentBlockParam[]', async () => {
    const session = new AgentSession(config);
    session.queueFrameworkContext(NUDGE);

    const blocks: ContentBlockParam[] = [{ type: 'text', text: 'describe this' }];
    await drain(session.sendMessageStream(blocks));

    const sent = capturedTurns[0]!.content as ContentBlockParam[];
    expect(Array.isArray(sent)).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ type: 'text', text: NUDGE });
    expect(sent[1]).toEqual({ type: 'text', text: 'describe this' });
    await session.close();
  });

  it('records the combined message in conversation history (ledger/transcript parity)', async () => {
    // The displacement bug was invisible in transcripts because the pushed
    // nudge bypassed recordUser. With ride-along delivery the history entry
    // must contain exactly what the model saw.
    const session = new AgentSession(config);
    session.queueFrameworkContext(NUDGE);

    await drain(session.sendMessageStream('/resolve'));

    const userEntries = session.getHistory().filter((m) => m.role === 'user');
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]!.content).toBe(`${NUDGE}\n\n/resolve`);
    await session.close();
  });

  it('ignores empty and whitespace-only context', async () => {
    const session = new AgentSession(config);
    session.queueFrameworkContext('');
    session.queueFrameworkContext('   \n  ');

    await drain(session.sendMessageStream('plain'));

    expect(capturedTurns[0]!.content).toBe('plain');
    await session.close();
  });

  it('exposes the queue on getInputStreamRef — the channel SubagentStop delivery uses', async () => {
    const session = new AgentSession(config);
    const ref = session.getInputStreamRef();

    expect(typeof ref.queueFrameworkContext).toBe('function');
    ref.queueFrameworkContext!(NUDGE);

    await drain(session.sendMessageStream('next real message'));

    expect(capturedTurns).toHaveLength(1);
    expect(capturedTurns[0]!.content).toBe(`${NUDGE}\n\nnext real message`);
    await session.close();
  });
});
