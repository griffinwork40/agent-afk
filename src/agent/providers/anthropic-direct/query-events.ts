import type { ProviderEvent } from '../../provider.js';

/** Terminal event used when a turn is aborted before the loop emits one. */
export function interruptedTurnCompletedEvent(sessionId: string): ProviderEvent {
  return {
    type: 'turn.completed',
    usage: {
      stopReason: 'interrupted',
      resultSubtype: 'interrupted',
      isError: false,
    },
    sessionId,
  };
}
