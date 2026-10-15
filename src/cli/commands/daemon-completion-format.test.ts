/**
 * Tests for `formatTaskCompletion` — empty-output success warning (#2365).
 *
 * Covers:
 *   - Empty-string response text on a success record → ⚠️ no-output header, no ✅.
 *   - Whitespace-only response text → same treatment as empty.
 *   - Non-empty response text → plain ✅ header (existing behaviour unchanged).
 *   - skipped / error records with empty text → unaffected (no spurious warning).
 *   - Downgraded (Done-unverified) record with empty text → downgrade header
 *     takes priority; no double warning.
 *   - responseExcerpt (no details.responseText) that is empty → ⚠️ warning.
 *   - responseExcerpt that is non-empty → plain ✅ header.
 */

import { describe, it, expect } from 'vitest';
import { formatTaskCompletion } from './daemon.js';
import type { TelemetryRecord } from '../../agent/daemon/scheduler.js';

function makeRecord(
  overrides: Partial<TelemetryRecord> = {},
): TelemetryRecord {
  return {
    taskId: 'nightly',
    command: 'run',
    trigger: 'cron',
    triggeredAt: new Date(0).toISOString(),
    durationMs: 1200,
    status: 'success',
    responseExcerpt: '',
    ...overrides,
  };
}

describe('formatTaskCompletion — empty-output success warning', () => {
  it('shows ⚠️ no-output header when responseText is empty string', () => {
    const result = formatTaskCompletion(makeRecord(), { responseText: '' });
    expect(result).toContain('⚠️ daemon task: nightly (success, no output)');
    expect(result).not.toContain('✅');
  });

  it('shows ⚠️ no-output header when responseText is whitespace only', () => {
    const result = formatTaskCompletion(makeRecord(), { responseText: '   \n\t  ' });
    expect(result).toContain('⚠️ daemon task: nightly (success, no output)');
    expect(result).not.toContain('✅');
  });

  it('does NOT append the whitespace body when responseText is whitespace-only', () => {
    const result = formatTaskCompletion(makeRecord(), { responseText: '   ' });
    // Body section should not appear — no extra blank line + whitespace block.
    const lines = result.split('\n');
    // Every line should either be a header/metadata line or empty (no whitespace content).
    const nonMetaLines = lines.filter(
      (l) =>
        l !== '' &&
        !l.startsWith('⚠️') &&
        !l.startsWith('trigger='),
    );
    expect(nonMetaLines).toHaveLength(0);
  });

  it('shows plain ✅ header when responseText is non-empty', () => {
    const result = formatTaskCompletion(makeRecord(), { responseText: 'ran ok' });
    expect(result).toContain('✅ daemon task: nightly (success)');
    expect(result).not.toContain('⚠️');
    expect(result).toContain('ran ok');
  });

  it('skipped status with empty text: ⏭️ header, no ⚠️ warning', () => {
    const result = formatTaskCompletion(
      makeRecord({ status: 'skipped', skipReason: 'already-done' }),
      { responseText: '' },
    );
    expect(result).toContain('⏭️ daemon task: nightly (skipped)');
    expect(result).not.toContain('⚠️');
  });

  it('error status with empty text: ❌ header, no ⚠️ warning', () => {
    const result = formatTaskCompletion(
      makeRecord({ status: 'error', errorMessage: 'boom' }),
      { responseText: '' },
    );
    expect(result).toContain('❌ daemon task: nightly (error)');
    expect(result).not.toContain('⚠️ daemon task');
  });

  it('downgraded (Done unverified) with empty text: downgrade header takes priority, no double warning', () => {
    const result = formatTaskCompletion(
      makeRecord(),
      { responseText: '', doneUnverified: true },
      true,
    );
    expect(result).toContain('⚠️ Done (unverified)');
    // The no-output warning must NOT appear alongside the downgrade warning.
    expect(result).not.toContain('success, no output');
    expect(result).not.toContain('✅');
  });

  it('shows ⚠️ no-output when responseExcerpt is empty and no details.responseText', () => {
    const result = formatTaskCompletion(makeRecord({ responseExcerpt: '' }));
    expect(result).toContain('⚠️ daemon task: nightly (success, no output)');
    expect(result).not.toContain('✅');
  });

  it('shows ✅ when responseExcerpt is non-empty and no details.responseText', () => {
    const result = formatTaskCompletion(makeRecord({ responseExcerpt: 'some output' }));
    expect(result).toContain('✅ daemon task: nightly (success)');
    expect(result).toContain('some output');
    expect(result).not.toContain('⚠️');
  });

  it('no-output warning is absent when details.responseText overrides an empty excerpt', () => {
    const result = formatTaskCompletion(
      makeRecord({ responseExcerpt: '' }),
      { responseText: 'actual output' },
    );
    expect(result).toContain('✅ daemon task: nightly (success)');
    expect(result).not.toContain('⚠️');
  });
});
