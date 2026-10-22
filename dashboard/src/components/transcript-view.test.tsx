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
