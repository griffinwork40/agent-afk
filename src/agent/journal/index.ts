/**
 * Message journal public surface. Import from here, not from sub-paths.
 * Design: docs/message-journal.md.
 *
 * @module agent/journal
 */

export * from './types.js';
export { JournalSync, type SyncOptions } from './sync.js';
export { JournalProvenance } from './provenance.js';
export { createMessageJournal, isMessageJournalDisabled, type CreateMessageJournalOptions } from './writer.js';
export {
  findToolResult,
  foldJournal,
  hydrateMessages,
  journalExists,
  listSubagentJournals,
  loadJournalFold,
  loadJournalMessages,
  readJournalRecords,
  type FoldResult,
  type JournalLocator,
} from './reader.js';
export { findToolResultAsync } from './reader.async.js';
export { forkJournal } from './fork.js';
export { foldForDisplay, loadDisplayMessages } from './display-fold.js';
