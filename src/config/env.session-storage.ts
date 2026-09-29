/**
 * Per-session storage env vars (session ledger + message journal): a
 * contiguous slice of `ENV_REGISTRY`.
 *
 * Extracted from `env.ts` to keep that file within the 350-code-line ceiling,
 * following the `env.whatif.ts` precedent. `env.ts` spreads this tuple into
 * `ENV_REGISTRY` at the position the entries used to occupy, so registry
 * order, the derived `EnvObject` / `EnvVarName` types, and the rendered
 * `docs/env-registry.*` are unchanged.
 *
 * Contract: data only. Never read `process.env` here (the single read-point
 * stays `env.ts`); `EnvVarMeta` is imported as a type so there is no cycle.
 *
 * @module config/env.session-storage
 */

import type { EnvVarMeta } from './env.js';

export const SESSION_STORAGE_ENV_REGISTRY = [
  {
    name: 'AFK_MESSAGE_JOURNAL_DISABLED',
    description:
      'Disable the per-session message journal (state/sessions/<id>/journal.jsonl + blobs/). ' +
      'The journal records the full conversation, including full tool results, and is the ' +
      'source for --resume and /fork. Set to 1 to skip journal writes; resume then falls back ' +
      'to the text-only sidecar history.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'debug',
  },
  {
    name: 'AFK_SESSION_LEDGER_DISABLED',
    description:
      'Disable the per-session durable event ledger (state/sessions/<id>/events.jsonl). ' +
      'Set to 1 to skip ledger writes; live cross-surface watching (e.g. the Telegram ' +
      '/watch command) will report no activity for sessions started while disabled.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'debug',
  },
] as const satisfies readonly EnvVarMeta[];
