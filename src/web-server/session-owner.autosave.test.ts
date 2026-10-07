import { describe, it, expect, vi } from 'vitest';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { drainAndPersistTurn, webTurnLabel } from './session-owner.autosave.js';
import type { AgentSession } from '../agent/session/agent-session.js';
import type { SessionAutosaver } from '../cli/session-autosave.js';

function fakeSession(events: unknown[], throwAfter = false): AgentSession {
  return {
    async *sendMessageStream() {
      for (const e of events) yield e;
      if (throwAfter) throw new Error('stream failed');
    },
  } as unknown as AgentSession;
}

function fakeSaver(): SessionAutosaver & { saveTurn: ReturnType<typeof vi.fn> } {
  return { stats: {} as SessionAutosaver['stats'], saveTurn: vi.fn() };
}

describe('webTurnLabel', () => {
  it('uses a plain prompt as-is', () => {
    expect(webTurnLabel('hello')).toBe('hello');
  });

  it('renders a skill invocation payload as /<skill> <args>', () => {
    const blocks: ContentBlockParam[] = [
      { type: 'text', text: '<command-name>/review</command-name>\n<command-args>32</command-args>\nRun the skill.' },
    ];
    expect(webTurnLabel(blocks)).toBe('/review 32');
  });
});

describe('drainAndPersistTurn', () => {
  it('saves a completed turn with its label, text, and metadata', async () => {
    const saver = fakeSaver();
    await drainAndPersistTurn(
      fakeSession([
        { type: 'message', message: { role: 'assistant', content: 'answer' } },
        { type: 'done', metadata: { totalCostUsd: 0.3 } },
      ]),
      'question',
      saver,
    );
    expect(saver.saveTurn).toHaveBeenCalledWith('question', 'answer', { totalCostUsd: 0.3 }, []);
  });

  it('does not save a turn that never reached done', async () => {
    const saver = fakeSaver();
    await drainAndPersistTurn(fakeSession([{ type: 'message', message: { role: 'assistant', content: 'x' } }]), 'q', saver);
    expect(saver.saveTurn).not.toHaveBeenCalled();
  });

  it('propagates a stream failure without saving', async () => {
    const saver = fakeSaver();
    await expect(drainAndPersistTurn(fakeSession([], true), 'q', saver)).rejects.toThrow('stream failed');
    expect(saver.saveTurn).not.toHaveBeenCalled();
  });
});
