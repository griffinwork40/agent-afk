import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ledgerRecordToItem } from '@/lib/ledger-adapter';
import { groupIntoSpineSlots } from './transcript-spine';
import { TranscriptView } from './transcript-view';

const text = 'claude-sonnet-4-6 hit its usage limit. Continuing on gpt-4o.';
const notice = ledgerRecordToItem({ kind: 'model_fallback', from: 'claude-sonnet-4-6', to: 'gpt-4o', text })!;

describe('dashboard model fallback notice', () => {
  it.each([true, false])('renders exactly one switch notice (spineMode=%s)', (spineMode) => {
    render(<TranscriptView items={[
      { kind: 'user', id: 'user', text: 'hello' }, notice,
      { kind: 'assistant', id: 'answer', text: 'Fallback answer' },
    ]} spineMode={spineMode} />);
    expect(screen.getAllByText(text)).toHaveLength(1);
    expect(screen.getByText('Fallback answer')).toBeTruthy();
  });

  it('does not swallow a switch next to an execution run, while keeping generic activity notices suppressed', () => {
    const slots = groupIntoSpineSlots([
      { kind: 'notice', id: 'activity', text: 'tool wave complete' }, notice,
      { kind: 'notice', id: 'done', text: 'Done' },
    ]);
    expect(slots).toEqual([{ kind: 'text', item: notice }]);
  });
});
