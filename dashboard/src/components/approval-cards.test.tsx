import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ApprovalCards } from './approval-cards';
import type { PendingApproval } from '@/types/api';
import * as api from '@/lib/api';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue({}),
}));

function makeApproval(overrides: Partial<PendingApproval['request']> = {}): PendingApproval {
  return {
    id: 'req-1',
    request: {
      title: 'Test approval',
      message: 'Please respond',
      type: 'confirm',
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.mocked(api.apiFetch).mockResolvedValue({});
});

describe('ApprovalCards — number type', () => {
  it('renders a number input', () => {
    render(<ApprovalCards approvals={[makeApproval({ type: 'number' })]} />);
    expect(screen.getByRole('spinbutton')).toBeTruthy();
  });

  it('submit button is disabled when input is empty', () => {
    render(<ApprovalCards approvals={[makeApproval({ type: 'number', questionDefault: '' })]} />);
    const btn = screen.getByRole('button', { name: /submit/i });
    expect(btn).toHaveProperty('disabled', true);
  });

  it('submit button is disabled when input is NaN', () => {
    render(<ApprovalCards approvals={[makeApproval({ type: 'number' })]} />);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: 'abc' } });
    const btn = screen.getByRole('button', { name: /submit/i });
    expect(btn).toHaveProperty('disabled', true);
  });

  it('submit button is enabled for a valid number', () => {
    render(<ApprovalCards approvals={[makeApproval({ type: 'number', questionDefault: '42' })]} />);
    const btn = screen.getByRole('button', { name: /submit/i });
    expect(btn).toHaveProperty('disabled', false);
  });

  it('submits Number value on accept', async () => {
    render(<ApprovalCards approvals={[makeApproval({ type: 'number', questionDefault: '7' })]} />);
    const btn = screen.getByRole('button', { name: /submit/i });
    fireEvent.click(btn);
    await vi.waitFor(() => {
      expect(api.apiFetch).toHaveBeenCalledWith(
        '/api/approve',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"number":7'),
        }),
      );
    });
  });
});

describe('ApprovalCards — number type with min/max', () => {
  it('renders with min and max attributes on the input', () => {
    render(
      <ApprovalCards
        approvals={[makeApproval({ type: 'number', questionMin: 1, questionMax: 10, questionDefault: '5' })]}
      />,
    );
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    expect(input.min).toBe('1');
    expect(input.max).toBe('10');
  });

  it('submit button is disabled when value is below questionMin', () => {
    render(
      <ApprovalCards
        approvals={[makeApproval({ type: 'number', questionMin: 5, questionDefault: '3' })]}
      />,
    );
    const btn = screen.getByRole('button', { name: /submit/i });
    expect(btn).toHaveProperty('disabled', true);
  });

  it('submit button is disabled when value is above questionMax', () => {
    render(
      <ApprovalCards
        approvals={[makeApproval({ type: 'number', questionMax: 10, questionDefault: '15' })]}
      />,
    );
    const btn = screen.getByRole('button', { name: /submit/i });
    expect(btn).toHaveProperty('disabled', true);
  });

  it('submit button is enabled when value is within bounds', () => {
    render(
      <ApprovalCards
        approvals={[makeApproval({ type: 'number', questionMin: 1, questionMax: 10, questionDefault: '5' })]}
      />,
    );
    const btn = screen.getByRole('button', { name: /submit/i });
    expect(btn).toHaveProperty('disabled', false);
  });

  it('does not call apiFetch when value is out of bounds on click', async () => {
    render(
      <ApprovalCards
        approvals={[makeApproval({ type: 'number', questionMin: 1, questionMax: 10, questionDefault: '0' })]}
      />,
    );
    const btn = screen.getByRole('button', { name: /submit/i });
    fireEvent.click(btn);
    await new Promise((r) => setTimeout(r, 50));
    expect(api.apiFetch).not.toHaveBeenCalled();
  });
});

describe('ApprovalCards — confirm type', () => {
  it('renders Yes and No buttons', () => {
    render(<ApprovalCards approvals={[makeApproval({ type: 'confirm' })]} />);
    expect(screen.getByRole('button', { name: /yes/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /no/i })).toBeTruthy();
  });
});

describe('ApprovalCards — text type', () => {
  it('renders a text input', () => {
    render(<ApprovalCards approvals={[makeApproval({ type: 'text' })]} />);
    expect(screen.getByRole('textbox')).toBeTruthy();
  });
});

describe('approval accessibility', () => {
  it('announces approvals, accepts Y while focused, and restores composer focus after persistence', async () => {
    render(<><textarea data-testid="composer-textarea" placeholder="Running… (Esc or ⌘. to stop, Enter to queue)" /><ApprovalCards approvals={[makeApproval()]} /></>);
    expect(screen.getByRole('status')).toHaveTextContent('Approval required: Test approval');
    const card = screen.getByRole('dialog', { name: 'Test approval' });
    card.focus();
    fireEvent.keyDown(card, { key: 'y' });
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('textbox')).toHaveFocus();
    expect(api.apiFetch).toHaveBeenLastCalledWith('/api/approve', expect.objectContaining({ body: expect.stringContaining('"action":"accept"') }));
  });
  it('declines with N but ignores modified shortcuts and repeated submissions', async () => {
    render(<ApprovalCards approvals={[makeApproval()]} />);
    const card = screen.getByRole('dialog');
    const before = vi.mocked(api.apiFetch).mock.calls.length;
    fireEvent.keyDown(card, { key: 'n', ctrlKey: true });
    expect(vi.mocked(api.apiFetch).mock.calls.length).toBe(before);
    fireEvent.keyDown(card, { key: 'n' });
    fireEvent.keyDown(card, { key: 'y' });
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(vi.mocked(api.apiFetch).mock.calls.length).toBe(before + 1);
    expect(api.apiFetch).toHaveBeenLastCalledWith('/api/approve', expect.objectContaining({ body: expect.stringContaining('"action":"decline"') }));
  });
  it('retains the card and focus on a failed request', async () => {
    vi.mocked(api.apiFetch).mockRejectedValueOnce(new Error('offline'));
    render(<ApprovalCards approvals={[makeApproval()]} />);
    const card = screen.getByRole('dialog'); card.focus();
    fireEvent.keyDown(card, { key: 'y' });
    await vi.waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Failed to submit'));
    expect(card).toHaveFocus();
  });
});
