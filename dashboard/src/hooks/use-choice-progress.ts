import { useMemo } from 'react';

export interface ChoiceRequest {
  corrId: string;
  title: string;
  options: { value: string; label: string; description?: string }[];
  default?: string;
  cancellable?: boolean;
}

export interface CommandProgress {
  corrId: string;
  label: string;
  fraction?: number;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function choice(value: unknown): ChoiceRequest | null {
  if (!object(value) || typeof value.corrId !== 'string' ||
      typeof value.title !== 'string' || !Array.isArray(value.options) ||
      (value.cancellable !== undefined && typeof value.cancellable !== 'boolean')) return null;
  const options: ChoiceRequest['options'] = [];
  for (const option of value.options) {
    if (!object(option) || typeof option.value !== 'string' || typeof option.label !== 'string') return null;
    options.push({ value: option.value, label: option.label,
      ...(typeof option.description === 'string' ? { description: option.description } : {}) });
  }
  if (options.length === 0) return null;
  return { corrId: value.corrId, title: value.title, options,
    ...(typeof value.cancellable === 'boolean' ? { cancellable: value.cancellable } : {}),
    ...(typeof value.default === 'string' ? { default: value.default } : {}) };
}

/** Project ephemeral command events from the authenticated session SSE stream.
 * Replay reconstructs pending choices; a settlement in any tab removes them.
 * The caller's stream resets its event array on navigation/clear, so no stale
 * request can leak into a different session or ledger generation.
 */
export function useChoiceProgress(events: unknown[]): { choices: ChoiceRequest[]; progress: CommandProgress[] } {
  return useMemo(() => {
    const choices = new Map<string, ChoiceRequest>();
    const progress = new Map<string, CommandProgress>();
    for (const event of events) {
      if (!object(event)) continue;
      if (event.type === 'choice_stream_boundary') {
        choices.clear();
        progress.clear();
      } else if (event.type === 'choice_request') {
        const request = choice(event.request);
        if (request) choices.set(request.corrId, request);
      } else if (event.type === 'choice_settled' && typeof event.corrId === 'string') {
        choices.delete(event.corrId);
      } else if (event.type === 'progress' && typeof event.corrId === 'string') {
        if (event.phase === 'end') {
          progress.delete(event.corrId);
        } else if ((event.phase === 'start' || event.phase === 'update') && typeof event.label === 'string') {
          const fraction = typeof event.fraction === 'number' && Number.isFinite(event.fraction)
            ? Math.max(0, Math.min(1, event.fraction)) : undefined;
          progress.set(event.corrId, { corrId: event.corrId, label: event.label,
            ...(fraction !== undefined ? { fraction } : {}) });
        }
      }
    }
    return { choices: [...choices.values()], progress: [...progress.values()] };
  }, [events]);
}
