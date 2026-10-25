/** Authenticated/Origin-checked by server.ts before reaching this choice answer route. */
import type { ServerResponse } from 'node:http';
import type { RouteContext } from './routes.js';
import { requireValidSessionId, sendJson } from './routes.js';

export function handleChoiceAnswer(
  ctx: RouteContext,
  res: ServerResponse,
  sessionId: string,
  corrId: string,
  body: unknown,
): void {
  if (!requireValidSessionId(res, sessionId)) return;
  if (!ctx.owned.has(sessionId)) {
    sendJson(res, 409, { error: 'session_not_owned' });
    return;
  }
  if (!ctx.choiceBroker) {
    sendJson(res, 501, { error: 'choices_not_supported' });
    return;
  }
  if (typeof body !== 'object' || body === null || !('value' in body) ||
    !((body as { value: unknown }).value === null || typeof (body as { value: unknown }).value === 'string')) {
    sendJson(res, 400, { error: 'bad_request', message: 'body must be { value: string | null }' });
    return;
  }
  const result = ctx.choiceBroker.answer(sessionId, corrId, (body as { value: string | null }).value);
  switch (result) {
    case 'answered': sendJson(res, 200, { answered: true }); break;
    case 'unknown': sendJson(res, 404, { error: 'unknown_choice' }); break;
    case 'wrong_session': sendJson(res, 409, { error: 'wrong_session' }); break;
    case 'invalid_value': sendJson(res, 400, { error: 'invalid_choice' }); break;
  }
}
