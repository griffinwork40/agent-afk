import type { AgentSession } from '../session.js';

export type CompactProgress = (phase: 'start' | 'end') => void;
export type CompactConversationResult = Awaited<ReturnType<AgentSession['compact']>> & {
  promptsBefore: number;
  promptsAfter: number;
};

type CompactSession = Pick<AgentSession,
  'hookRegistry' | 'sessionId' | 'listRewindTargets' | 'compact'>;

/**
 * Hooks may block/throw before progress starts. Counts refer to genuine user
 * prompts, not provider messages (which include tool rounds). No spinner or
 * busy policy lives here: callers reserve/queue as appropriate, and interpret
 * the unchanged provider result (including session-busy). Hook/abort/provider
 * errors propagate so each surface can render its existing error semantics.
 */
export async function compactConversation(
  session: CompactSession,
  progress?: CompactProgress,
): Promise<CompactConversationResult> {
  await session.hookRegistry?.dispatch({
    event: 'PreCompact', sessionId: session.sessionId, trigger: 'manual',
  });
  try {
    progress?.('start');
    const promptsBefore = session.listRewindTargets().length;
    const result = await session.compact();
    const promptsAfter = session.listRewindTargets().length;
    return { ...result, promptsBefore, promptsAfter };
  } finally {
    progress?.('end');
  }
}
