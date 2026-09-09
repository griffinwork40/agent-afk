/**
 * Ledger-adapter re-export for the React dashboard.
 *
 * The canonical implementation lives at:
 *   src/web-server/shared/ledger-adapter.ts
 *
 * Both this file and src/web-server/frontend/ledger-adapter.ts re-export from
 * that single source of truth so schema changes are applied in exactly one
 * place. See #1582.
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
