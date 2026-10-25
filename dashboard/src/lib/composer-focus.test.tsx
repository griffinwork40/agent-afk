import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { expect, it } from 'vitest';
import { requestComposerFocus, useComposerFocusRequest } from './composer-focus';

function Probe({ enabled }: { enabled: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useComposerFocusRequest(ref, enabled);
  return <textarea ref={ref} data-testid="ta" disabled={!enabled} />;
}

it('returns false when no composer is mounted', () => {
  expect(requestComposerFocus()).toBe(false);
});

it('defers focus until the composer is enabled again (Esc focus race)', () => {
  const { getByTestId, rerender } = render(<Probe enabled={false} />);
  act(() => { expect(requestComposerFocus()).toBe(true); });
  // Still disabled: focus cannot land yet and must not be lost.
  expect(document.activeElement).toBe(document.body);
  rerender(<Probe enabled />);
  expect(document.activeElement).toBe(getByTestId('ta'));
});

it('focuses immediately when already enabled', () => {
  const { getByTestId } = render(<Probe enabled />);
  act(() => { requestComposerFocus(); });
  expect(document.activeElement).toBe(getByTestId('ta'));
});
