import { describe, it, expect } from 'vitest';
import { formatSubagentCompletion } from './commands/interactive/progress-banner.js';

describe('formatSubagentCompletion', () => {
  it('shows check icon for succeeded status', () => {
    const out = formatSubagentCompletion({ subagentId: 'sa-1', status: 'succeeded', durationMs: 3000 });
    expect(out).toContain('✓');
    expect(out).toContain('sa-1');
    expect(out).toContain('3s');
  });

  it('shows cross icon for failed status', () => {
    const out = formatSubagentCompletion({ subagentId: 'sa-2', status: 'failed', durationMs: 1500 });
    expect(out).toContain('✗');
    expect(out).toContain('sa-2');
  });

  it('shows fallback icon for cancelled status', () => {
    const out = formatSubagentCompletion({ subagentId: 'sa-3', status: 'cancelled' });
    expect(out).toContain('⊘');
  });

  it('uses agentType as label when present', () => {
    const out = formatSubagentCompletion({ subagentId: 'sa-4', status: 'succeeded', agentType: 'research-agent' });
    expect(out).toContain('research-agent');
    expect(out).not.toContain('sa-4');
  });

  it('falls back to subagentId when agentType is undefined', () => {
    const out = formatSubagentCompletion({ subagentId: 'sa-5', status: 'succeeded' });
    expect(out).toContain('sa-5');
  });

  it('omits duration when durationMs is undefined', () => {
    const out = formatSubagentCompletion({ subagentId: 'sa-6', status: 'succeeded' });
    expect(out).not.toContain('·');
  });

  it('includes formatted duration when durationMs is present', () => {
    const out = formatSubagentCompletion({ subagentId: 'sa-7', status: 'succeeded', durationMs: 65_000 });
    expect(out).toContain('· 1m 5s');
  });
});
