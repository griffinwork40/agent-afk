import { existsSync, readFileSync } from 'node:fs';
import { jsonConfigTierPaths } from '../../cli/config/json-tier-paths.js';
import { ALL_TOOL_SCHEMAS } from './schemas.js';
import { memoryToolSchemas } from '../memory/memory-tools.js';
import { stateToolSchemas } from '../state/state-schemas.js';
import type { ToolPermissionConfig } from './permissions.js';
import { isMcpDenyEntry } from './operator-denied.match.js';

export { isMcpDenyEntry, isToolDenied } from './operator-denied.match.js';

/** Core tools remain available regardless of operator visibility settings. */
export const LOCKED_TOOLS: ReadonlySet<string> = new Set([
  'agent', 'skill', 'compose', 'exit_plan_mode', 'get_runtime_state',
  'read_file', 'write_file', 'edit_file', 'grep', 'glob', 'list_directory',
]);

/** Fixed group names, intentionally not a general glob language. */
export const TOOL_GROUP_NAMES = ['browser', 'image', 'clipboard', 'peer', 'schedules'] as const;

// Contract: computed lazily (first call, then memoized) so loading this module
// never dereferences schema arrays during import-cycle evaluation.
let groupsCache: Readonly<Record<string, readonly string[]>> | undefined;
let builtinCache: ReadonlySet<string> | undefined;

/** Group name -> member tool names. */
export function toolGroups(): Readonly<Record<string, readonly string[]>> {
  groupsCache ??= {
    browser: ALL_TOOL_SCHEMAS.filter((s) => s.name.startsWith('browser_')).map((s) => s.name),
    image: ['image_generate', 'image_edit'],
    clipboard: ['clipboard_read', 'clipboard_write'],
    peer: ['list_sessions', 'send_to_session'],
    schedules: ['create_schedule', 'update_schedule', 'list_schedules', 'get_schedule_history', 'cancel_schedule'],
  };
  return groupsCache;
}

function builtinNames(): ReadonlySet<string> {
  builtinCache ??= new Set([
    ...ALL_TOOL_SCHEMAS, ...memoryToolSchemas, ...stateToolSchemas,
  ].map((s) => s.name).concat([...LOCKED_TOOLS], ['workspace_publish', 'workspace_query', 'workspace_subscribe']));
  return builtinCache;
}
const warned = new Set<string>();

function warn(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.error(`[tools.disabled] ${message}`);
}

/** Reset per-session warning dedup so daemon processes warn on each new session. */
export function resetWarnings(): void {
  warned.clear();
}

/** Parse one tier without dropping valid entries beside malformed values. */
export function parseDisabledTools(value: unknown, source: string, customNames: readonly string[] = []): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warn(`${source}: tools.disabled must be an array of strings.`);
    return [];
  }
  const names = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      warn(`${source}: tools.disabled contains a non-string entry (got ${typeof entry}).`);
      continue;
    }
    if (LOCKED_TOOLS.has(entry)) {
      warn(`Ignoring locked core tool "${entry}".`);
    } else if (Object.hasOwn(toolGroups(), entry)) {
      for (const name of toolGroups()[entry]!) names.add(name);
    } else if (builtinNames().has(entry) || customNames.includes(entry) || isMcpDenyEntry(entry)) {
      names.add(entry);
    } else {
      warn(`Ignoring unknown tool entry "${entry}".`);
    }
  }
  return [...names];
}

/** Snapshot the union of ALL config tiers at provider construction, not per query. */
export function resolveOperatorDeniedTools(customNames: readonly string[] = []): string[] {
  // Reset warning dedup so daemon processes warn once per session, not once ever.
  warned.clear();
  const denied = new Set<string>();
  for (const { path } of jsonConfigTierPaths()) {
    if (!existsSync(path)) continue;
    try {
      const json: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const tools = json && typeof json === 'object' && 'tools' in json ? json.tools : undefined;
      const value = tools && typeof tools === 'object' && 'disabled' in tools ? tools.disabled : undefined;
      for (const name of parseDisabledTools(value, path, customNames)) denied.add(name);
    } catch {
      warn(`${path}: unable to parse config; other tiers still apply.`);
    }
  }
  return [...denied];
}

/** Apply operator denies last without mutating the allowlist or losing prior denies. */
export function withOperatorDenied(
  base: ToolPermissionConfig | undefined,
  denied: readonly string[],
): ToolPermissionConfig | undefined {
  if (denied.length === 0) return base;
  // Identity short-circuit: when the deny list is exactly what base already carries, skip allocation.
  if (
    base?.deniedTools &&
    denied.length === base.deniedTools.length &&
    denied.every((d, i) => d === base.deniedTools![i])
  ) return base;
  return { ...base, deniedTools: [...new Set([...(base?.deniedTools ?? []), ...denied])] };
}

/** Snapshot operator settings for a newly constructed provider. */
export function snapshotOperatorPermissions(
  base: ToolPermissionConfig | undefined,
  customNames: readonly string[] = [],
): ToolPermissionConfig | undefined {
  return withOperatorDenied(base, resolveOperatorDeniedTools(customNames));
}
