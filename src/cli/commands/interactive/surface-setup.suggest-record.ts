/**
 * Journal sink for AI ghost-text suggestions (docs/message-journal.md).
 *
 * The suggest engine reports every usable LLM proposal and the user's response
 * to it; this writes each one into the live session's message journal as a
 * `mark('suggestion', detail)`. Marks never affect the folded message array,
 * so resume and fork are unchanged.
 *
 * Invariant (persistence boundary): `text` and `buffer` pass through
 * `redactSecrets` HERE, immediately before they reach disk, mirroring the
 * Tier-2 egress scrub in suggest-tier2.ts. Upstream values stay raw on purpose
 * (`buffer` is the Tier-2 cache key and prefix-guard input).
 *
 * The session is read through the ref at record time, never captured, so a
 * mid-session `/resume` swap journals into the session now in use.
 */

import { redactSecrets } from '../../../agent/redact-secrets.js';
import type { JournalSuggestionDetail } from '../../../agent/journal/types.js';
import type { SessionRef } from '../../../agent/session-ref.js';
import type { SuggestionRecorder } from '../../input/suggest.js';

export function buildSuggestionJournalRecorder(session: SessionRef): SuggestionRecorder {
  return (rec) => {
    const journal = session.current.messageJournal;
    if (journal === undefined) return;
    const detail: JournalSuggestionDetail = {
      ...rec,
      text: redactSecrets(rec.text),
      ...(rec.buffer !== undefined ? { buffer: redactSecrets(rec.buffer) } : {}),
    };
    journal.mark('suggestion', detail);
  };
}
