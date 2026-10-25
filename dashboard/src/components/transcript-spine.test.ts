import { describe, it, expect } from 'vitest';
import { groupIntoSpineSlots } from './transcript-spine';
import type { TranscriptItem } from '@/lib/ledger-adapter';

describe('groupIntoSpineSlots', () => {
  it('renders a stopped marker as a text slot (and terminates)', () => {
    const items: TranscriptItem[] = [
      { kind: 'user', id: 'u1', text: 'go' },
      { kind: 'assistant', id: 'a1', text: 'partial' },
      { kind: 'stopped', id: 'n1', text: 'Stopped' },
    ];
    const slots = groupIntoSpineSlots(items);
    expect(slots.map((s) => s.kind === 'text' ? s.item.kind : 'execution')).toEqual(['user', 'assistant', 'stopped']);
  });

  it('never loops on a kind it does not classify', () => {
    const items = [{ kind: 'future_kind', id: 'x1', text: 'x' }] as unknown as TranscriptItem[];
    expect(groupIntoSpineSlots(items)).toHaveLength(1);
  });
});
