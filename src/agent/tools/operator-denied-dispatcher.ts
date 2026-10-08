import { snapshotOperatorPermissions } from './operator-denied.js';
import { isToolDenied, operatorDeniedReason } from './operator-denied.match.js';
import { SessionToolDispatcher } from './dispatcher.js';
import type { ToolPermissionConfig } from './permissions.js';
import type { AnthropicToolDef, ToolCall, ToolDispatcher, ToolResult } from '../providers/anthropic-direct/types.js';

/** Symbol brand used to identify operator-denied wrapper dispatchers.
 * Avoids false-positive duck-type matches from coincidental `operatorDenied`
 * properties on unrelated dispatchers. */
const OPERATOR_DENIED_BRAND = Symbol('operatorDenied');

/** A consumer-owned dispatcher wrapped so operator denies still apply. */
type GuardedDispatcher = ToolDispatcher & {
  readonly [OPERATOR_DENIED_BRAND]: true;
  readonly operatorDenied: readonly string[];
};

function isGuarded(d: ToolDispatcher): d is GuardedDispatcher {
  return (d as Partial<GuardedDispatcher>)[OPERATOR_DENIED_BRAND] === true;
}

/**
 * Wrap a consumer-owned dispatcher (`opts.tools`) so operator denies are not
 * bypassed: denied calls are rejected before reaching `inner`, and the denied
 * names are exposed for {@link operatorDispatcherToolDefs} to filter the
 * advertised catalog. Returns `inner` unchanged when nothing is denied.
 */
export function withOperatorDeniedDispatcher(
  inner: ToolDispatcher | undefined,
  permissions: ToolPermissionConfig | undefined,
): ToolDispatcher | undefined {
  if (!inner || !permissions?.deniedTools?.length) return inner;
  const denied = permissions.deniedTools;
  // Idempotent: if the inner is already guarded with the SAME deny set, return
  // it unchanged to avoid double-wrapping.  Compare sets explicitly so a second
  // call with a different deny list produces a new wrapper rather than silently
  // retaining the original (which could under-deny when the set expands).
  if (
    isGuarded(inner) &&
    inner.operatorDenied.length === denied.length &&
    inner.operatorDenied.every((name, i) => name === denied[i])
  ) {
    return inner;
  }
  const wrapped: GuardedDispatcher = {
    [OPERATOR_DENIED_BRAND]: true,
    operatorDenied: denied,
    async execute(call: ToolCall): Promise<ToolResult> {
      if (isToolDenied(call.name, denied)) return { isError: true, content: operatorDeniedReason(call.name) };
      return inner.execute(call);
    },
    setResolveBase: (cwd: string) => inner.setResolveBase?.(cwd),
    setAllowAll: (allow: boolean) => inner.setAllowAll?.(allow),
  };
  return wrapped;
}

/** Construct OpenAI options with a deny snapshot and guarded external dispatcher. */
export function snapshotOperatorOptions<T extends { permissions?: ToolPermissionConfig; tools?: ToolDispatcher; customTools?: readonly { schema: { name: string } }[] }>(opts: T): T {
  const permissions = snapshotOperatorPermissions(opts.permissions, opts.customTools?.map((t) => t.schema.name));
  return { ...opts, permissions, tools: withOperatorDeniedDispatcher(opts.tools, permissions) };
}

/**
 * Advertised catalog for a query dispatcher. Contract: identical to the
 * pre-deny behaviour (SessionToolDispatcher -> its own filtered `toolDefs`;
 * any other dispatcher -> `fallback`), except a guarded external dispatcher's
 * fallback has operator-denied names removed.
 */
export function operatorDispatcherToolDefs(
  dispatcher: ToolDispatcher,
  fallback: readonly AnthropicToolDef[],
): readonly AnthropicToolDef[] {
  if (dispatcher instanceof SessionToolDispatcher) return dispatcher.toolDefs;
  if (!isGuarded(dispatcher)) return fallback;
  return fallback.filter((s) => !isToolDenied(s.name, dispatcher.operatorDenied));
}
