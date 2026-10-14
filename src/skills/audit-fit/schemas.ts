/**
 * Schemas, types, and pure helper functions for /audit-fit.
 * Extracted so handler.ts and index.ts can both import from here
 * without creating a circular dependency.
 *
 * @module skills/audit-fit/schemas
 */

import { z } from 'zod';
import type { SubagentResult } from '../../agent/subagent/result.js';
import type { DiscoveredHook } from './discover.js';

/**
 * Schema for a single artifact verdict.
 *
 * `source` distinguishes user-authored artifacts (`~/.afk/{skills,commands,agents}/`)
 * from plugin-shipped artifacts (`~/.afk/plugins/<plugin>/{skills,commands,agents}/`).
 * `plugin_key` is set only when `source === 'plugin'` and identifies the plugin
 * via the same key shape used by `plugins-scanner`'s `indexKeyForPath`
 * (e.g., `"data"` for flat layout, `"<marketplace>:<plugin>"` for cache layout).
 */
export const VerdictSchema = z.object({
  path: z.string(),
  type: z.enum(['skill', 'command', 'agent', 'hook']),
  source: z.enum(['user', 'plugin']),
  plugin_key: z.string().optional(),
  verdict: z.enum(['correct', 'misfit', 'outlier']),
  recommended_type: z.string(),
  rationale: z.string(),
  confidence: z.enum(['high', 'med', 'low']),
});

export type Verdict = z.infer<typeof VerdictSchema>;

/**
 * Inventory matrix shape: type -> verdict-category -> count.
 * Hooks always live under the user-scope inventory.
 */
export const InventoryMatrixSchema = z.record(
  z.string(),
  z.record(z.string(), z.number()),
);

export type InventoryMatrix = z.infer<typeof InventoryMatrixSchema>;

/**
 * Schema for the complete audit-fit result.
 * Inventory is split into user-scope and plugin-scope sub-matrices.
 */
export const AuditFitResultSchema = z.object({
  inventory: z.object({
    user: InventoryMatrixSchema,
    plugin: InventoryMatrixSchema,
  }),
  misfits: z.array(VerdictSchema),
  briefs_written: z.number(),
  total_artifacts: z.number(),
});

export type AuditFitResult = z.infer<typeof AuditFitResultSchema>;

/**
 * Input schema for the /audit-fit skill.
 *
 * - `writeBriefs` (default true): generate migration briefs for high-confidence
 *   user-scope misfits. Plugin-scope misfits never produce briefs regardless of
 *   this flag (refactoring vendored plugin code is the maintainer's job).
 * - `scope` (default 'all'): restrict the audit. `'plugin'` skips the hook
 *   inspector since hooks are user-scope only.
 */
export const AuditFitInputSchema = z.object({
  writeBriefs: z.boolean().optional(),
  scope: z.enum(['user', 'plugin', 'all']).optional(),
});

export type AuditFitInput = z.infer<typeof AuditFitInputSchema>;

export type Scope = 'user' | 'plugin' | 'all';
export type FullArtifactType = 'skill' | 'command' | 'agent' | 'hook';
type VerdictCategory = 'correct' | 'misfit' | 'outlier';

export const ALL_TYPES: ReadonlyArray<FullArtifactType> = ['skill', 'command', 'agent', 'hook'];

/**
 * Decide which discovery phases and inspectors run for a given scope.
 * Pure function -- exported for testing.
 */
export function planAuditScope(scope: Scope): {
  runUserDiscovery: boolean;
  runPluginDiscovery: boolean;
  runHookInspector: boolean;
} {
  return {
    runUserDiscovery: scope !== 'plugin',
    runPluginDiscovery: scope !== 'user',
    runHookInspector: scope !== 'plugin',
  };
}

/**
 * Aggregate a flat list of verdicts into the nested inventory matrix
 * (source x type x verdict-category) plus a misfits list sorted by confidence.
 * Pure function -- exported for testing.
 */
export function aggregateVerdicts(verdicts: ReadonlyArray<Verdict>): {
  inventory: AuditFitResult['inventory'];
  misfits: Verdict[];
} {
  const makeMatrix = (): Record<FullArtifactType, Record<VerdictCategory, number>> => {
    const m = {} as Record<FullArtifactType, Record<VerdictCategory, number>>;
    for (const t of ALL_TYPES) {
      m[t] = { correct: 0, misfit: 0, outlier: 0 };
    }
    return m;
  };
  const inventory = { user: makeMatrix(), plugin: makeMatrix() };
  for (const v of verdicts) {
    inventory[v.source][v.type][v.verdict] += 1;
  }
  const confidenceOrder: Record<Verdict['confidence'], number> = {
    high: 0,
    med: 1,
    low: 2,
  };
  const misfits = verdicts
    .filter((v) => v.verdict === 'misfit')
    .slice()
    .sort((a, b) => confidenceOrder[a.confidence] - confidenceOrder[b.confidence]);
  return { inventory, misfits };
}

/**
 * Predicate: should this misfit produce a migration brief?
 * Only high-confidence user-scope misfits get briefs -- plugin-scope misfits
 * never do, because the user doesn't own that code.
 * Pure function -- exported for testing.
 */
export function shouldWriteBriefForMisfit(m: Verdict): boolean {
  return m.verdict === 'misfit' && m.confidence === 'high' && m.source === 'user';
}

/**
 * Render a templated hook list to append to the hook inspector prompt. The
 * absolute settings.json path goes inline so the inspector never has to expand
 * `~/.afk/` against an unknown subagent $HOME -- the original failure mode
 * resolved `~` to `/root` and dead-ended at `/root/.afk/settings.json`.
 */
export function renderHookList(settingsPath: string, hooks: ReadonlyArray<DiscoveredHook>): string {
  const out: string[] = ['', '## Discovered hooks (audit only these)', ''];
  out.push(
    `Settings file (use this absolute path verbatim in each verdict's \`path\` field): \`${settingsPath}\``,
  );
  out.push('');
  if (hooks.length === 0) {
    out.push('(no hooks discovered)');
    return out.join('\n');
  }
  for (const h of hooks) {
    const id = `${h.event}-${h.index}`;
    out.push(`### Hook \`${id}\``);
    out.push('');
    out.push('```json');
    out.push(JSON.stringify(h.raw, null, 2));
    out.push('```');
    out.push('');
  }
  return out.join('\n');
}

/**
 * Outcome of validating a single inspector subagent's `SubagentResult`.
 * Either a one-line failure message (with cause) or the parsed verdicts ready
 * to aggregate.
 */
export type InspectorOutcome =
  | { kind: 'failure'; message: string }
  | { kind: 'success'; output: ReadonlyArray<Verdict> };

/**
 * Classify an inspector's result into a failure message or parsed verdicts.
 *
 * Contract: order matters: `buildResultFromMessage` sets `status: 'failed'` AND
 * populates `schemaError` (with `error` left undefined) when
 * `outputSchema.safeParse` fails. So the schemaError branch must come before
 * the generic status check -- otherwise the dedicated "schema mismatch" message
 * gets swallowed by a bare "<type>: failed".
 *
 * Pure function -- exported for testing.
 */
export function classifyInspectorResult(
  type: FullArtifactType,
  result: SubagentResult<ReadonlyArray<Verdict>> | undefined,
): InspectorOutcome {
  if (!result) return { kind: 'failure', message: `${type}: no result` };
  if (result.schemaError) {
    return {
      kind: 'failure',
      message: `${type}: schema mismatch \u2014 ${result.schemaError.message}`,
    };
  }
  if (result.status !== 'succeeded') {
    const errSuffix = result.error ? ` \u2014 ${result.error.message}` : '';
    return {
      kind: 'failure',
      message: `${type}: ${result.status}${errSuffix}`,
    };
  }
  if (!result.output) return { kind: 'failure', message: `${type}: no output` };
  return { kind: 'success', output: result.output };
}
