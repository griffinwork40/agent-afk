/**
 * Path helpers for the pre-existing-defect ledger.
 *
 * Lives beside the subsystem (like `src/improve/paths.ts`) rather than in
 * `src/paths.ts`, which sits at the 350-code-line ceiling. Both paths derive
 * from `getAgentFrameworkDir()` so `$AFK_HOME` overrides are honoured and
 * nothing here is ever written inside a repo checkout.
 *
 * @module agent/preexisting-ledger/paths
 */

import { join } from 'node:path';
import { getAgentFrameworkDir } from '../../paths.js';

/** Append-only JSONL written by the SessionEnd hook. */
export function getPreexistingLedgerPath(): string {
  return join(getAgentFrameworkDir(), 'preexisting-ledger.jsonl');
}

/** Markdown ledger written by `pnpm backfill:preexisting`. */
export function getPreexistingBackfillPath(): string {
  return join(getAgentFrameworkDir(), 'preexisting-backfill.md');
}
