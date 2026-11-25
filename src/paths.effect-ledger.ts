import { join } from 'node:path';
import { getAfkStateDir } from './paths.js';

/**
 * Path to the durable external-effect ledger.
 *
 * NDJSON file at `$AFK_STATE_DIR/effect-ledger.jsonl`. Each line is an
 * {@link EffectRecord} (see `src/agent/effect-ledger/types.ts`). Append-only
 * for new records; status updates append a new line (last-write-wins on query).
 *
 * Lives at the state-dir root alongside `session-grants.jsonl` — it is
 * process-global state (not per-session) because the same effect may originate
 * from multiple sessions that need to share the dedup record.
 */
export function getEffectLedgerPath(): string {
  return join(getAfkStateDir(), 'effect-ledger.jsonl');
}
