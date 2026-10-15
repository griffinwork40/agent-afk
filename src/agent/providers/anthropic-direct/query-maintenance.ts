import type {
  ProviderCompactResult,
  ProviderRewindConversationResult,
  RewindTarget,
} from '../../provider.js';
import type { AbortCoordinator } from '../shared/abort-coordinator.js';
import { compactHistory } from './query/compact-handler.js';
import { listUserTurns, rewindConversationHistory } from './query/rewind-conversation.js';
import type { RetryLayer } from './query/retry-layer.js';
import type { SessionState } from './query/session-state.js';

export function compactQueryHistory(options: {
  state: SessionState;
  abort: AbortCoordinator;
  retry: RetryLayer;
  initSessionId: string;
  traceWriter?: import('../../trace/index.js').TraceSink;
}): Promise<ProviderCompactResult> {
  return compactHistory(options).then((result) => {
    // Journal the compaction splice as truncate + re-append of the summary.
    // The splice replaces index 0, so that re-append also covers any
    // microcompaction edits made after it.
    if (result.compacted) {
      options.state.journalSync.sync(options.state.messages, { reason: 'compact' });
      options.state.messageJournal?.mark('compact');
    } else if (result.microcompaction && result.microcompaction.blocksCleared > 0) {
      // Microcompaction-only: placeholders were written IN PLACE into
      // already-synced messages (invisible to the by-reference diff), so
      // invalidate from the first edited message and re-sync.
      options.state.journalSync.invalidateFrom(result.microcompaction.firstClearedIndex ?? 0);
      options.state.journalSync.sync(options.state.messages, { reason: 'compact' });
    }
    return result;
  });
}

export function queryRewindTargets(state: SessionState): RewindTarget[] {
  return listUserTurns(state.messages);
}

export function rewindQueryConversation(
  state: SessionState,
  abort: AbortCoordinator,
  turnIndex: number,
): ProviderRewindConversationResult {
  return rewindConversationHistory({ state, abort }, turnIndex);
}
