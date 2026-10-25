import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TranscriptView } from './transcript-view';
import type { TranscriptItem } from '@/lib/ledger-adapter';

const initialItems: TranscriptItem[] = [
  { kind: 'user', id: 'user', text: 'Question' },
  { kind: 'thinking', id: 'thinking', text: 'Original reasoning' },
  { kind: 'assistant', id: 'assistant', text: 'Answer' },
];

describe.each([true, false])('thinking display (spineMode=%s)', (spineMode) => {
  it('hides old and incoming thinking when off and restores both without modifying data', () => {
    const items = initialItems.map((item) => Object.freeze({ ...item }));
    const { rerender } = render(<TranscriptView items={items} spineMode={spineMode} />);
    expect(screen.getByText('Original reasoning')).toBeTruthy();
    rerender(<TranscriptView items={items} spineMode={spineMode} thinkingUi="off" />);
    expect(screen.queryByText('Original reasoning')).toBeNull();
    expect(screen.getByText('Answer')).toBeTruthy();
    expect(screen.getByText('Question')).toBeTruthy();

    const incoming: TranscriptItem[] = [...items, { kind: 'thinking', id: 'new', text: 'Incoming reasoning' }];
    rerender(<TranscriptView items={incoming} spineMode={spineMode} thinkingUi="off" />);
    expect(screen.queryByText('Incoming reasoning')).toBeNull();
    rerender(<TranscriptView items={incoming} spineMode={spineMode} thinkingUi="live" />);
    expect(screen.getByText('Original reasoning')).toBeTruthy();
    expect(screen.getByText('Incoming reasoning')).toBeTruthy();
    expect(items).toEqual(initialItems);
    expect(incoming).toHaveLength(4);
  });

  it.each(['summary', 'digest'] as const)('keeps thinking available in %s mode', (thinkingUi) => {
    render(<TranscriptView items={initialItems} spineMode={spineMode} thinkingUi={thinkingUi} />);
    expect(screen.getByText('Original reasoning')).toBeTruthy();
  });
});

describe('workingState (indicator visibility + phase)', () => {
  it('a streaming THINKING draft does not hide the indicator (only answer text does)', async () => {
    const { workingState } = await import('./transcript-view');
    const user = { kind: 'user' as const, id: 'u', text: 'q' };
    const thinking = { kind: 'thinking' as const, id: 't', text: 'Let me consider the list', live: 'streaming' };
    const answer = { kind: 'assistant' as const, id: 'a', text: 'Hello', live: 'streaming' };
    expect(workingState([user, thinking] as never, true).showWorking).toBe(true);
    expect(workingState([user, thinking, answer] as never, true).showWorking).toBe(false);
  });
  it('keeps the indicator while the streaming draft has no visible text, hides it once text shows', async () => {
    const { workingState } = await import('./transcript-view');
    const user = { kind: 'user' as const, id: 'u', text: 'q' };
    const empty = { kind: 'assistant' as const, id: 'd', text: '', live: 'streaming' };
    const fence = { kind: 'assistant' as const, id: 'd', text: '```ty', live: 'streaming' };
    const shown = { kind: 'assistant' as const, id: 'd', text: 'Hello', live: 'streaming' };
    expect(workingState([user, empty], true).showWorking).toBe(true);
    expect(workingState([user, fence], true).showWorking).toBe(true);
    expect(workingState([user, shown], true).showWorking).toBe(false);
  });

  it('a sealed draft with visible text hides the indicator (no "Thinking 0s" flash at turn end)', async () => {
    const { workingState } = await import('./transcript-view');
    const user = { kind: 'user' as const, id: 'u', text: 'q' };
    const sealed = { kind: 'assistant' as const, id: 'd', text: 'Final answer', live: 'sealed' };
    const sealedEmpty = { kind: 'assistant' as const, id: 'd', text: '   ', live: 'sealed' };
    expect(workingState([user, sealed], true).showWorking).toBe(false);
    // Visible-text rule still holds for sealed drafts.
    expect(workingState([user, sealedEmpty], true).showWorking).toBe(true);
    // Pre-tool text seals when the tool starts: "Running <tool>" stays.
    const tool = { kind: 'tool' as const, id: 't', name: 'bash', inputPreview: 'ls', status: 'running' as const };
    expect(workingState([user, tool, sealed], true)).toMatchObject({ showWorking: true, workingPhase: 'running', runningTool: 'bash' });
    // After the tool finishes the next segment starts empty: "Writing…".
    const next = { kind: 'assistant' as const, id: 'd2', text: '', live: 'streaming' };
    expect(workingState([user, { ...tool, status: 'ok' as const }, next], true)).toMatchObject({ showWorking: true });
  });

  it("a previous turn's sealed draft must not hide the next turn's indicator", async () => {
    const { workingState } = await import('./transcript-view');
    const u1 = { kind: 'user' as const, id: 'u1', text: 'first' };
    const prevSealed = { kind: 'assistant' as const, id: 'd1', text: 'Old answer', live: 'sealed' };
    const u2 = { kind: 'user' as const, id: 'u2', text: 'second' };
    expect(workingState([u1, prevSealed, u2], true)).toMatchObject({ showWorking: true, workingPhase: 'thinking' });
    // And in the overlay order (drafts after every durable item) the current turn's sealed text counts.
    expect(workingState([u1, u2, { ...prevSealed, id: 'd2' }], true).showWorking).toBe(false);
  });

  it('a bare markdown marker ("1.") is not visible text yet', async () => {
    const { workingState } = await import('./transcript-view');
    const user = { kind: 'user' as const, id: 'u', text: 'q' };
    const marker = { kind: 'assistant' as const, id: 'd', text: '1.', live: 'streaming' };
    const worded = { kind: 'assistant' as const, id: 'd', text: '1. One', live: 'streaming' };
    expect(workingState([user, marker], true).showWorking).toBe(true);
    expect(workingState([user, worded], true).showWorking).toBe(false);
  });

  it('reports Running <tool> while the newest tool has no result, then Writing', async () => {
    const { workingState } = await import('./transcript-view');
    const user = { kind: 'user' as const, id: 'u', text: 'q' };
    const tool = { kind: 'tool' as const, id: 't', name: 'bash', inputPreview: 'sleep 4', status: 'running' as const };
    expect(workingState([user, tool], true)).toMatchObject({ showWorking: true, workingPhase: 'running', runningTool: 'bash' });
    expect(workingState([user, { ...tool, status: 'ok' as const }], true)).toMatchObject({ workingPhase: 'writing' });
  });

  it('renders "Running bash" in the indicator', async () => {
    const { TranscriptView: View } = await import('./transcript-view');
    const { render: r } = await import('@testing-library/react');
    const { container } = r(<View turnActive items={[{ kind: 'user', id: 'u', text: 'q' }, { kind: 'tool', id: 't', name: 'bash', inputPreview: 'sleep 4', status: 'running' }]} />);
    expect(container.querySelector('[data-testid="working-indicator"]')?.textContent).toContain('Running bash');
  });
});
