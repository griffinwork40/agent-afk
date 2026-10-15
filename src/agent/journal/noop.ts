/**
 * The disabled journal (`AFK_MESSAGE_JOURNAL_DISABLED=1`): length 0, every
 * method a no-op, subagent journals are itself. Never touches disk.
 *
 * @module agent/journal/noop
 */

import { env } from '../../config/env.js';
import type { MessageJournal } from './types.js';

/** True when `AFK_MESSAGE_JOURNAL_DISABLED=1`. */
export function isMessageJournalDisabled(): boolean {
  return env.AFK_MESSAGE_JOURNAL_DISABLED === '1';
}

export const NOOP_JOURNAL: MessageJournal = Object.freeze({
  length: 0,
  append(): void {},
  truncate(): void {},
  mark(): void {},
  forSubagent(): MessageJournal {
    return NOOP_JOURNAL;
  },
  flush(): Promise<void> {
    return Promise.resolve();
  },
  close(): Promise<void> {
    return Promise.resolve();
  },
});
