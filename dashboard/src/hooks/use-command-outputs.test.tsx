import { act, renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useCommandOutputs } from './use-command-outputs';
import type { CommandResponse } from '@/types/command-wire';

const response: CommandResponse = { blocks: [{ text: 'Saved cost', ansi: 'Saved cost' }], control: { kind: 'continue' } };

it('restores per-session output anchors and unique keys after a reload/remount', () => {
  const first = renderHook(() => useCommandOutputs());
  act(() => first.result.current.addItem('one', '/cost', response, 3));
  const key = first.result.current.itemsFor('one')[0]!.key;
  first.unmount();
  const second = renderHook(() => useCommandOutputs());
  expect(second.result.current.itemsFor('one')).toMatchObject([{ input: '/cost', afterCount: 3 }]);
  expect(second.result.current.itemsFor('two')).toEqual([]);
  act(() => second.result.current.addItem('one', '/cost', response, 4));
  expect(second.result.current.itemsFor('one')[1]!.key).toBeGreaterThan(key);
  act(() => second.result.current.clearItems('one'));
  second.unmount();
  expect(renderHook(() => useCommandOutputs()).result.current.itemsFor('one')).toEqual([]);
});

it('ignores corrupt storage and preserves only the clear confirmation when requested', () => {
  sessionStorage.setItem('afk.command-outputs.v1', 'not json');
  const { result } = renderHook(() => useCommandOutputs());
  expect(result.current.itemsFor('one')).toEqual([]);
  act(() => result.current.addItem('one', '/cost', response, 3));
  act(() => result.current.addItem('one', '/clear', { ...response, control: { kind: 'clear' } }, 3));
  act(() => result.current.clearItems('one', true));
  expect(result.current.itemsFor('one')).toMatchObject([{ input: '/clear', afterCount: 0 }]);
});
