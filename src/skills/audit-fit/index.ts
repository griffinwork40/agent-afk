/**
 * /audit-fit skill -- audits ~/.afk artifacts for correct type categorization.
 *
 * Discovers artifacts deterministically in TypeScript (user-scope from
 * `~/.afk/{skills,commands,agents}/`, plugin-scope via `scanLocalPlugins`,
 * hooks from `~/.afk/settings.json`), splits them by source, and forks
 * per-type inspector subagents that read the pre-discovered list and emit
 * verdicts. The synthesis layer aggregates verdicts into a nested inventory
 * matrix (`user` x `plugin`) and writes migration briefs only for
 * high-confidence user-scope misfits -- plugin-scope misfits are inventory
 * only because refactoring vendored plugin code is the maintainer's job.
 *
 * @module skills/audit-fit
 */

import { registerSkill, type SkillMetadata } from '../index.js';
import { handler } from './handler.js';

// Re-export all schemas, types, and pure functions so importers of this
// module keep their existing import paths unchanged.
export {
  VerdictSchema,
  InventoryMatrixSchema,
  AuditFitResultSchema,
  AuditFitInputSchema,
  planAuditScope,
  aggregateVerdicts,
  shouldWriteBriefForMisfit,
  renderHookList,
  classifyInspectorResult,
  ALL_TYPES,
} from './schemas.js';

export type {
  Verdict,
  InventoryMatrix,
  AuditFitResult,
  AuditFitInput,
  Scope,
  FullArtifactType,
  InspectorOutcome,
} from './schemas.js';

export type { SkillExecutionContext } from '../index.js';

export const auditFitSkill: SkillMetadata = {
  name: 'audit-fit',
  description:
    "Audit ~/.afk artifacts (skills, commands, agents, hooks) for correct type categorization. Walks user-scope dirs (~/.afk/{skills,commands,agents}/) and every plugin installed under ~/.afk/plugins/ (flat and marketplace-cache layouts), plus ~/.afk/settings.json for hooks. Dispatches per-type inspectors in parallel, applies decision heuristics (progressive-disclosure value, isolation need, deterministic vs. reasoning), flags misfits. Generates migration briefs only for user-scope misfits (plugin misfits are inventory-only -- refactoring vendored plugin code is the maintainer's job). Optional `scope` input filters to `user`, `plugin`, or `all` (default). Use for inventory audits after bulk authoring, imports, or periodic hygiene.",
  handler,
  argumentHint: '[--write-briefs]',
  whenToUse: 'When the user wants ~/.afk artifacts (skills, commands, agents, hooks) audited for correct type categorization.',
  flags: ['--write-briefs'],
  // Maintainer-loop skill: writes briefs to `$AFK_HOME/agent-framework/briefs/`.
  // End users have no use for the brief output, so the skill is hidden unless
  // `AFK_INTERNAL=1` unlocks it.
  audience: 'internal',
  category: 'Review & verify',
};

registerSkill(auditFitSkill);
