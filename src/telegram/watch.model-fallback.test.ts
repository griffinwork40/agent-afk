/**
 * Tests for `renderLedgerRecord` — focused on the model_fallback record kind.
 */

import { describe, it, expect } from 'vitest';
import { renderLedgerRecord } from './watch.js';
import type { LedgerRecord } from '../agent/session-ledger.js';

function makeRecord(payload: object): LedgerRecord {
  return { v: 1, ts: Date.now(), ...payload } as LedgerRecord;
}

describe('renderLedgerRecord — model_fallback', () => {
  it('renders a model_fallback record with from and to', () => {
    const rec = makeRecord({ kind: 'model_fallback', from: 'opus', to: 'sonnet', reason: 'usage-limit', text: 'switched' });
    const result = renderLedgerRecord(rec);
    expect(result).not.toBeNull();
    expect(result).toContain('opus');
    expect(result).toContain('sonnet');
  });

  it('returns null for unknown record kinds (backward compat)', () => {
    const rec = makeRecord({ kind: 'some_unknown_kind' });
    const result = renderLedgerRecord(rec);
    expect(result).toBeNull();
  });
});
