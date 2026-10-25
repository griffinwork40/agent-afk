import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChoiceDialog } from './choice-dialog';
import { apiFetch } from '@/lib/api';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
afterEach(() => vi.clearAllMocks());

it('shows resolved catalogue labels in the model choice dialog', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ models: [{ id: 'haiku', label: 'haiku · Claude Haiku 5.5' }] });
  render(<ChoiceDialog sessionId="one" onAnswered={vi.fn()} request={{ corrId: 'model', title: 'Select model', options: [{ value: 'haiku', label: 'haiku' }] }} />);
  expect(await screen.findByRole('radio', { name: 'haiku · Claude Haiku 5.5' })).toBeTruthy();
});

const request = {
  corrId: 'corr / 1', title: 'Pick a revision', cancellable: true,
  default: 'two',
  options: [{ value: 'one', label: 'First', description: 'Earlier revision' }, { value: 'two', label: 'Second' }],
};

it('focuses the default, arrow-selects choices, traps Tab and restores focus after settlement', async () => {
  const before = document.createElement('button');
  document.body.append(before);
  before.focus();
  vi.mocked(apiFetch).mockResolvedValue({});
  const done = vi.fn();
  const { unmount } = render(<ChoiceDialog sessionId="session / one" request={request} onAnswered={done} />);
  const dialog = screen.getByRole('dialog');
  const first = screen.getByRole('radio', { name: /First/ });
  const second = screen.getByRole('radio', { name: 'Second' });
  expect(document.activeElement).toBe(second);
  before.focus();
  expect(document.activeElement).toBe(second);
  fireEvent.keyDown(second, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(first);
  expect(first.getAttribute('aria-checked')).toBe('true');
  fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Select' }));
  fireEvent.keyDown(dialog, { key: 'Tab' });
  expect(document.activeElement).toBe(first);
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(apiFetch).toHaveBeenCalledWith('/api/sessions/session%20%2F%20one/choices/corr%20%2F%201', {
    method: 'POST', body: JSON.stringify({ value: 'one' }),
  });
  unmount();
  expect(document.activeElement).toBe(before);
  before.remove();
});

it('bounds long catalogs with an independently scrollable choices region and pointer selection', async () => {
  vi.mocked(apiFetch).mockResolvedValue({});
  const done = vi.fn();
  const options = Array.from({ length: 40 }, (_, index) => ({ value: `model-${index}`, label: `Model ${index}` }));
  render(<ChoiceDialog sessionId="long" request={{ ...request, default: 'model-39', options }} onAnswered={done} />);
  const dialog = screen.getByRole('dialog');
  const choices = screen.getByRole('radiogroup', { name: 'Choices' });
  expect(dialog.className.split(/\s+/)).toEqual(expect.arrayContaining(['flex', 'flex-col', 'max-h-[calc(100dvh-2rem)]']));
  expect(choices.className.split(/\s+/)).toEqual(expect.arrayContaining(['min-h-0', 'overflow-y-auto']));
  // Only the option list scrolls: the title and both footer actions remain outside it.
  expect(choices.contains(screen.getByRole('heading', { name: request.title }))).toBe(false);
  expect(choices.contains(screen.getByRole('button', { name: 'Select' }))).toBe(false);
  expect(choices.contains(screen.getByRole('button', { name: 'Cancel' }))).toBe(false);
  expect(screen.getAllByRole('radio')).toHaveLength(40);
  fireEvent.click(screen.getByRole('radio', { name: /^Model 0$/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(apiFetch).toHaveBeenCalledWith('/api/sessions/long/choices/corr%20%2F%201', {
    method: 'POST', body: JSON.stringify({ value: 'model-0' }),
  });
});

it('Escape cancels only cancellable choices and failed submissions retain the dialog', async () => {
  vi.mocked(apiFetch).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({});
  const done = vi.fn();
  const { rerender } = render(<ChoiceDialog sessionId="one" request={request} onAnswered={done} />);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  await screen.findByRole('alert');
  expect(done).not.toHaveBeenCalled();
  expect(apiFetch).toHaveBeenCalledWith('/api/sessions/one/choices/corr%20%2F%201', {
    method: 'POST', body: JSON.stringify({ value: null }),
  });
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  rerender(<ChoiceDialog sessionId="one" request={{ ...request, cancellable: false }} onAnswered={done} />);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  await act(async () => {});
  expect(apiFetch).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
});
