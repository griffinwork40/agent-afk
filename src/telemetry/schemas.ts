/**
 * Canonical Zod schemas for shared cross-surface JSONL telemetry.
 *
 * Both the plugin surface and the CLI surface (TypeScript, agent-afk) write
 * to the same JSONL files under `~/.afk/agent-framework/`. These schemas are
 * the single source of truth — writers validate against them, and the
 * cross-surface test uses fixture entries to catch silent drift.
 */

import { z } from 'zod';

const isoTimestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

const surface = z.enum(['afk', 'plugin']);

// ---------------------------------------------------------------------------
// forge-telemetry.jsonl
// ---------------------------------------------------------------------------

export const ForgeTelemEntrySchema = z
  .object({
    timestamp: isoTimestamp,
    surface,
    event: z.string(),
  })
  .catchall(z.unknown());

export type ForgeTelemEntry = z.infer<typeof ForgeTelemEntrySchema>;
