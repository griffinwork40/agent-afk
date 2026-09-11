/**
 * Ledger-adapter re-export for the React dashboard.
 *
 * The canonical implementation lives at:
 *   src/web-server/shared/ledger-adapter.ts
 *
 * This file re-exports from that single source of truth (the legacy
 * vanilla-TS frontend re-exporter was removed in #1633) so schema changes
 * are applied in exactly one place. See #1582.
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
} from '../../../src/web-server/shared/ledger-adapter';

export {
  resetIdCounter,
  ledgerRecordToItem,
  accumulateTotals,
  ledgerToItems,
} from '../../../src/web-server/shared/ledger-adapter';
