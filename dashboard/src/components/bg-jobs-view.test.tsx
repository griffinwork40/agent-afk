import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BgJobsView } from './bg-jobs-view';
import * as api from '@/lib/api';
import type { BgJobMeta } from './bg-jobs-view.types';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

function makeJob(overrides: Partial<BgJobMeta> = {}): BgJobMeta {
  return {
    jobId: 'job-abc-123',
    subagentId: 'sub-1',
    label: 'Test job',
    model: 'claude-sonnet-4-5',
    startedAt: Date.now() - 5000,
    status: 'running',
    schemaVersion: 1,
    promptHash: 'abc123',
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(api.apiFetch).mockResolvedValue({ jobs: [] });
});

describe('BgJobsView — cancel button', () => {
  it('shows a disabled cancel button for running jobs', async () => {
    vi.mocked(api.apiFetch).mockResolvedValue({ jobs: [makeJob()] });
    render(<BgJobsView />);

    // The cancel button has aria-label matching "Cancel job ..."
    const cancelBtn = await screen.findByRole('button', {
      name: /cancel job/i,
    });
    expect(cancelBtn).toHaveProperty('disabled', true);
  });

  it('cancel button tooltip mentions /bgsub:cancel', async () => {
    vi.mocked(api.apiFetch).mockResolvedValue({
      jobs: [makeJob({ jobId: 'job-xyz' })],
    });
    render(<BgJobsView />);

    const cancelBtn = await screen.findByRole('button', { name: /cancel job/i });
    const title = cancelBtn.getAttribute('title') ?? '';
    expect(title).toContain('/bgsub:cancel');
    expect(title).toContain('job-xyz');
  });

  it('cancel button tooltip includes owner PID when present', async () => {
    vi.mocked(api.apiFetch).mockResolvedValue({
      jobs: [makeJob({ jobId: 'job-pid', ownerPid: 12345 })],
    });
    render(<BgJobsView />);

    const cancelBtn = await screen.findByRole('button', { name: /cancel job/i });
    expect(cancelBtn.getAttribute('title')).toContain('12345');
  });

  it('does not show cancel button for settled jobs', async () => {
    vi.mocked(api.apiFetch).mockResolvedValue({
      jobs: [makeJob({ status: 'completed' })],
    });
    render(<BgJobsView />);
    await screen.findByText('Test job');
    expect(screen.queryByRole('button', { name: /cancel job/i })).toBeNull();
  });

  it('renders empty state when no jobs', async () => {
    render(<BgJobsView />);
    expect(await screen.findByText(/no background jobs/i)).toBeTruthy();
  });
});
