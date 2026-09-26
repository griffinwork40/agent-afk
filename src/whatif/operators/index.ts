/**
 * Operator registry for the what-if prediction engine.
 *
 * Provides getOperator(kind), applyChanges(spec, env, ctx),
 * describeChange(change), specTouchesProject(spec), and homePathsToCopyFor(spec).
 *
 * @module whatif/operators
 */

import type {
  Change,
  ChangeKind,
  ChangeOperator,
  ChangeSpec,
  Environment,
  OperatorContext,
} from '../types.js';
import { appendOperator, fileOperator, hotOperator } from './content-ops.js';
import { memoryAddOperator, memoryRemoveOperator } from './memory-ops.js';
import { disableSkillOperator, disablePluginOperator } from './skill-plugin-ops.js';
import { modelOperator, effortOperator, envOperator } from './launch-ops.js';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

// Map from kind to its operator. Typed so that TS verifies we cover all kinds.
type OperatorMap = { [K in ChangeKind]: ChangeOperator<K> };

const REGISTRY: OperatorMap = {
  append: appendOperator,
  file: fileOperator,
  hot: hotOperator,
  'memory-add': memoryAddOperator,
  'memory-remove': memoryRemoveOperator,
  'disable-skill': disableSkillOperator,
  'disable-plugin': disablePluginOperator,
  model: modelOperator,
  effort: effortOperator,
  env: envOperator,
};

/**
 * Retrieve the operator for a given change kind. Always succeeds — the
 * exhaustive registry above is the source of truth.
 */
export function getOperator<K extends ChangeKind>(kind: K): ChangeOperator<K> {
  return REGISTRY[kind] as ChangeOperator<K>;
}

// ---------------------------------------------------------------------------
// Bulk helpers
// ---------------------------------------------------------------------------

/**
 * Apply all changes in a ChangeSpec to a candidate environment in order.
 * Validation (e.g. credential key rejection) happens inside each operator.
 */
export async function applyChanges(
  spec: ChangeSpec,
  env: Environment,
  ctx: OperatorContext,
): Promise<void> {
  for (const change of spec.changes) {
    const op = getOperator(change.kind);
    // TypeScript cannot narrow `change` through the generic registry; the cast
    // is safe because REGISTRY is keyed by kind.
    await (op as ChangeOperator).apply(change as never, env, ctx);
  }
}

/**
 * Plain-English one-liner for a single change.
 */
export function describeChange(change: Change): string {
  const op = getOperator(change.kind);
  return (op as ChangeOperator).describe(change as never);
}

/**
 * Returns true when ANY change in the spec needs a project worktree.
 */
export function specTouchesProject(spec: ChangeSpec): boolean {
  return spec.changes.some((c) => {
    const op = getOperator(c.kind);
    return (op as ChangeOperator).touchesProject(c as never);
  });
}

/**
 * Returns the set of home-relative paths that must be converted from symlinks
 * to real copies before apply, so writes never go through a symlink to the
 * real AFK_HOME tree.
 *
 * Deduplicates across all changes.
 */
export function homePathsToCopyFor(spec: ChangeSpec): string[] {
  const seen = new Set<string>();
  for (const c of spec.changes) {
    const op = getOperator(c.kind);
    for (const p of (op as ChangeOperator).homePathsToCopy(c as never)) {
      seen.add(p);
    }
  }
  return [...seen];
}
