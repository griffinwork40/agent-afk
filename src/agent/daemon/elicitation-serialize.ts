/**
 * Shared helper for serializing an `ElicitationRequest` into a plain
 * `Record<string, unknown>` suitable for durable handoff storage.
 *
 * Previously duplicated between `handoff-wiring.ts` and
 * `scheduler.elicitation-notify.ts` (#3558).
 *
 * @module agent/daemon/elicitation-serialize
 */

import type { ElicitationRequest } from '../types/sdk-types.js';

/**
 * Serialize the JSON-safe fields of an `ElicitationRequest` into a plain
 * record for durable storage. Copies only the known question metadata needed
 * for re-presentation, excluding unknown runtime fields. Nested metadata is
 * preserved as supplied by the typed request (not recursively sanitized).
 */
export function serializeRequest(request: ElicitationRequest): Record<string, unknown> {
  const out: Record<string, unknown> = { message: request.message };
  if (request.serverName !== undefined) out['serverName'] = request.serverName;
  if (request.mode !== undefined) out['mode'] = request.mode;
  if (request.url !== undefined) out['url'] = request.url;
  if (request.elicitationId !== undefined) out['elicitationId'] = request.elicitationId;
  if (request.requestedSchema !== undefined) out['requestedSchema'] = request.requestedSchema;
  if (request.title !== undefined) out['title'] = request.title;
  if (request.displayName !== undefined) out['displayName'] = request.displayName;
  if (request.description !== undefined) out['description'] = request.description;
  if (request.type !== undefined) out['type'] = request.type;
  if (request.choices !== undefined) out['choices'] = request.choices;
  if (request.questionDefault !== undefined) out['questionDefault'] = request.questionDefault;
  if (request.minLength !== undefined) out['minLength'] = request.minLength;
  if (request.maxLength !== undefined) out['maxLength'] = request.maxLength;
  if (request.min !== undefined) out['min'] = request.min;
  if (request.max !== undefined) out['max'] = request.max;
  if (request.allowSkip !== undefined) out['allowSkip'] = request.allowSkip;
  if (request.allowCustom !== undefined) out['allowCustom'] = request.allowCustom;
  if (request.context !== undefined) out['context'] = request.context;
  return out;
}
