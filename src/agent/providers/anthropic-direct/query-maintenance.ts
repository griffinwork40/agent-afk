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
  return compactHistory(options);
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
