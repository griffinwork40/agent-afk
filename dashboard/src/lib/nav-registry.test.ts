import { describe, expect, it } from 'vitest';
import { Brain } from 'lucide-react';
import { getNavItem, listNavItems, registerNavItem } from './nav-registry';

describe('navigation registry', () => {
  it('preserves the six built-in entries, labels and order', () => {
    expect(listNavItems().map(({ id, label }) => [id, label])).toEqual([
      ['sessions', 'Sessions'], ['memory', 'Memory'], ['schedules', 'Schedules'],
      ['jobs', 'Jobs'], ['handoffs', 'Handoffs'], ['settings', 'Settings'],
    ]);
    expect(getNavItem('jobs')?.title).toBe('Background Jobs');
    expect(getNavItem('handoffs')?.title).toBe('Pending Handoffs');
    expect(getNavItem('unknown')).toBeUndefined();
  });

  it('registers custom entries and replaces by id without reordering or duplication', () => {
    const item = { id: 'test-extension', label: 'Extension', title: 'Extension panel', icon: Brain };
    registerNavItem(item);
    item.label = 'mutated outside registry';
    expect(getNavItem(item.id)?.label).toBe('Extension');
    const before = listNavItems().map(({ id }) => id);
    registerNavItem({ ...item, label: 'Updated' });
    expect(listNavItems().map(({ id }) => id)).toEqual(before);
    expect(getNavItem(item.id)?.label).toBe('Updated');
    const copy = listNavItems();
    copy.pop();
    expect(getNavItem(item.id)).toBeDefined();
  });
});
