import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSessionUrl } from './use-session-url';

describe('useSessionUrl', () => {
  it('restores a copied URL and preserves unrelated query parameters', () => {
    window.history.replaceState({}, '', '/?session=one&filter=live');
    const { result } = renderHook(() => useSessionUrl());
    expect(result.current[0]).toBe('one');
    act(() => result.current[1]('two'));
    expect(window.location.search).toBe('?session=two&filter=live');
    expect(result.current[0]).toBe('two');
    act(() => result.current[1](null));
    expect(window.location.search).toBe('?filter=live');
  });

  it('restores back/forward navigation without creating an extra entry', async () => {
    window.history.replaceState({}, '', '/?session=one');
    const { result } = renderHook(() => useSessionUrl());
    act(() => result.current[1]('two'));
    act(() => window.history.back());
    await waitFor(() => expect(result.current[0]).toBe('one'));
    act(() => window.history.forward());
    await waitFor(() => expect(result.current[0]).toBe('two'));
  });
});
