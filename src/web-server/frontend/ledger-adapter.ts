/**
 * Ledger-adapter re-export for the legacy vanilla-TS frontend.
 *
 * The canonical implementation lives at:
 *   src/web-server/shared/ledger-adapter.ts
 *
 * Both this file and dashboard/src/lib/ledger-adapter.ts re-export from that
 * single source of truth so schema changes are applied in exactly one place.
 * See #1582.
 */

export type {
  TranscriptItem,
  ToolCallItem,
  SubagentItem,
  SessionTotals,
  LedgerRecordLike,
  SseStreamFrame,
  ToolIndex,
  SubagentIndex,
} from '../shared/ledger-adapter.js';

export {
  resetIdCounter,
  ledgerRecordToItem,
  accumulateTotals,
  ledgerToItems,
} from '../shared/ledger-adapter.js';
