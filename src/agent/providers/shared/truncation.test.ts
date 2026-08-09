import { describe, expect, it } from 'vitest';
import { truncationNotice } from './truncation.js';

describe('truncationNotice', () => {
  it('recommends continuation instead of an unsupported cap setting', () => {
    const notice = truncationNotice([], 'max_output_tokens', {
      canIncreaseOutputLimit: false,
    });

    expect(notice).toContain('Continue in a follow-up turn or retry');
    expect(notice).not.toContain('--max-output-tokens');
    expect(notice).not.toContain('AFK_MAX_OUTPUT_TOKENS');
  });

  it('uses the neutral remediation for an undispatched tool too', () => {
    const notice = truncationNotice(['read_file'], 'max_output_tokens', {
      canIncreaseOutputLimit: false,
    });

    expect(notice).toContain('NOT dispatched (read_file)');
    expect(notice).toContain('retry so the model can finish the action');
    expect(notice).not.toContain('--max-output-tokens');
  });

  it('keeps the configurable-cap remediation by default', () => {
    const notice = truncationNotice([], 'length');

    expect(notice).toContain('--max-output-tokens / AFK_MAX_OUTPUT_TOKENS');
  });
});
