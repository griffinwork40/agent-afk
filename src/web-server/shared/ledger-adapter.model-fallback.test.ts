/**
 * Tests for `ledgerRecordToItem` — focused on the model_fallback record kind.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ledgerRecordToItem, resetIdCounter } from './ledger-adapter.js';
import type { LedgerRecordLike } from './ledger-adapter.js';

beforeEach(() => { resetIdCounter(); });

describe('ledgerRecordToItem — model_fallback', () => {
  it('renders a model_fallback record as a notice item with from→to text', () => {
    const record: LedgerRecordLike = {
      kind: 'model_fallback',
      from: 'opus',
      to: 'sonnet',
      reason: 'usage-limit',
      text: 'opus hit its usage limit. Continuing on sonnet.',
    };
    const item = ledgerRecordToItem(record);
    expect(item).not.toBeUndefined();
    expect(item?.kind).toBe('notice');
    if (item?.kind === 'notice') {
      expect(item.text).toContain('opus');
      expect(item.text).toContain('sonnet');
    }
  });

  it('gracefully handles missing from/to fields', () => {
    const record: LedgerRecordLike = { kind: 'model_fallback' };
    const item = ledgerRecordToItem(record);
    expect(item).not.toBeUndefined();
    expect(item?.kind).toBe('notice');
  });

  it('old ledger records without model_fallback kind still load (default branch)', () => {
    // A record with an unknown kind returns undefined, not an error.
    const record: LedgerRecordLike = { kind: 'some_unknown_future_kind' };
    expect(ledgerRecordToItem(record)).toBeUndefined();
  });
});
