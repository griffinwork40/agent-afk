/**
 * Model-list route for the `afk web` surface.
 *
 * Contract: this handler is dispatched from `server.ts` after bearer-token
 * and Origin checks have already passed. The list is intentionally static —
 * no dynamic model discovery, no disk reads.
 */

import type { ServerResponse } from 'node:http';
import { sendJson } from './routes.js';

/** A single model option surfaced to the browser. */
export interface ModelInfo {
  /** Short identifier sent to createSession and the API. */
  id: string;
  /** Human-readable label shown in the selector. */
  label: string;
}

// Contract: this list matches the tier ids recognised by the afk config
// resolution layer (providerForModel). Only tiers a default install can
// actually reach are listed — vendor-specific full model names are not
// surfaced here because they change with provider releases and would need
// dynamic discovery.
const MODELS: readonly ModelInfo[] = [
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
  { id: 'opus', label: 'Opus' },
];

/** `GET /api/models` — return the static model list. */
export function handleListModels(res: ServerResponse): void {
  sendJson(res, 200, { models: MODELS });
}
