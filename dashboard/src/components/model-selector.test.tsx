import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi, afterEach } from 'vitest';
import { ModelSelector } from './model-selector';
import { apiFetch } from '@/lib/api';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
afterEach(() => vi.clearAllMocks());

it('starts with the server default, displays resolved names, and never chooses on mount', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ default: 'haiku', models: [{ id: 'haiku', label: 'haiku · Claude Haiku 5.5' }, { id: 'sonnet', label: 'sonnet · Claude Sonnet 4.6' }] });
  const select = vi.fn();
  render(<ModelSelector onSelect={select} />);
  await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('haiku'));
  expect(screen.getByRole('option', { name: 'haiku · Claude Haiku 5.5' })).toBeTruthy();
  expect(select).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'sonnet' } });
  expect(select).toHaveBeenCalledWith('sonnet');
});

it('retains an authoritative current model and ignores the unresolved placeholder', async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(apiFetch).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const select = vi.fn();
  const { rerender } = render(<ModelSelector onSelect={select} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
  expect(select).not.toHaveBeenCalled();
  await act(async () => resolve({ default: 'haiku', models: [] }));
  rerender(<ModelSelector onSelect={select} current="org/custom" />);
  expect(screen.getByRole('combobox')).toHaveValue('org/custom');
});
