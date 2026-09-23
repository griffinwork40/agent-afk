/**
 * State-guarded compaction and rewind operations, extracted from
 * {@link AgentSession} and {@link provider-passthrough}.
 *
 * These functions carry real session-state invariants — they inspect and
 * mutate `SessionState` around the provider call — distinguishing them
 * from the eight trivial delegations that are now inlined directly in
 * `AgentSession`. Keeping them here lets `agent-session.ts` stay within
 * the 350-code-line ceiling without losing the guard logic.
 *
 * @module agent/session/session-compact
 */

import type {
  ProviderCompactResult,
  ProviderQuery,
  ProviderRewindConversationResult,
  RewindTarget,
} from '../provider.js';
import type { SessionState } from '../types.js';

/** Minimal context bag for compact / rewind operations. */
export interface CompactDeps {
  getState: () => SessionState;
  setState: (s: SessionState) => void;
  getProviderQuery: () => ProviderQuery;
}

/**
 * Compact the session's conversation history via the provider.
 *
 * Guards against compacting when closed or busy.
 *
 * NOTE: the 'compacting' state guard is set here for the explicit
 * `AgentSession.compact()` call only. Auto-compact triggered inside
 * `sendMessageStreamInternal` does NOT go through this function and
 * therefore does NOT set 'compacting'. This is intentional.
 */
export async function compactSession(deps: CompactDeps): Promise<ProviderCompactResult> {
  if (deps.getState() === 'closed') {
    throw new Error('Cannot compact: session is closed');
  }
  if (deps.getState() !== 'idle') {
    return { compacted: false, reason: 'session-busy', messagesBefore: 0, messagesAfter: 0 };
  }
  const fn = deps.getProviderQuery().compact?.bind(deps.getProviderQuery());
  if (!fn) {
    return { compacted: false, reason: 'not-supported', messagesBefore: 0, messagesAfter: 0 };
  }
  deps.setState('compacting');
  try {
    return await fn();
  } finally {
    deps.setState('idle');
  }
}

/** List rewind targets from the provider. Returns empty array when closed. */
export function listRewindTargets(deps: CompactDeps): RewindTarget[] {
  if (deps.getState() === 'closed') return [];
  return deps.getProviderQuery().listRewindTargets?.() ?? [];
}

/**
 * Rewind the conversation to a prior turn index via the provider.
 * Guards against rewinding when closed or busy.
 */
export async function rewindConversation(
  turnIndex: number,
  deps: CompactDeps,
): Promise<ProviderRewindConversationResult> {
  if (deps.getState() === 'closed') {
    throw new Error('Cannot rewind: session is closed');
  }
  if (deps.getState() !== 'idle') {
    return { rewound: false, reason: 'session-busy', messagesBefore: 0, messagesAfter: 0 };
  }
  const fn = deps.getProviderQuery().rewindConversation?.bind(deps.getProviderQuery());
  if (!fn) {
    return { rewound: false, reason: 'not-supported', messagesBefore: 0, messagesAfter: 0 };
  }
  return fn(turnIndex);
}
