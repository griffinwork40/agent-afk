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
  /** The innermost (unguarded) raw dispatcher, stored to avoid double-gating. */
  readonly _rawInner: ToolDispatcher;
};

function isGuarded(d: ToolDispatcher): d is GuardedDispatcher {
  return (d as Partial<GuardedDispatcher>)[OPERATOR_DENIED_BRAND] === true;
}

/**
 * Wrap a consumer-owned dispatcher (`opts.tools`) so operator denies are not
 * bypassed: denied calls are rejected before reaching `inner`, and the denied
 * names are exposed for {@link operatorDispatcherToolDefs} to filter the
 * advertised catalog. Returns `inner` unchanged when nothing is denied.
 *
 * When `inner` is already a guarded dispatcher:
 *   - Same deny set (order-independent): returns `inner` unchanged (idempotent).
 *   - Different deny set: stores the UNION of both deny sets in the new wrapper
 *     so the advertised catalog and execution gate are always consistent.
 */
export function withOperatorDeniedDispatcher(
  inner: ToolDispatcher | undefined,
  permissions: ToolPermissionConfig | undefined,
): ToolDispatcher | undefined {
  if (!inner || !permissions?.deniedTools?.length) return inner;
  const denied = permissions.deniedTools;

  if (isGuarded(inner)) {
    // Order-independent set equality: same set → idempotent return.
    const incomingSet = new Set(denied);
    const existingSet = new Set(inner.operatorDenied);
    const sameSet =
      incomingSet.size === existingSet.size &&
      inner.operatorDenied.every((name) => incomingSet.has(name));
    if (sameSet) return inner;

    // Different sets: build the union so catalog and execution agree.
    // Delegate to `inner._rawInner` (the raw, unguarded dispatcher) so allowed
    // calls are not gated twice — the union check above is the only guard needed.
    const union = [...new Set([...existingSet, ...incomingSet])];
    const rawInner = inner._rawInner;
    const wrapped: GuardedDispatcher = {
      [OPERATOR_DENIED_BRAND]: true,
      operatorDenied: union,
      _rawInner: rawInner,
      async execute(call: ToolCall): Promise<ToolResult> {
        if (isToolDenied(call.name, union)) return { isError: true, content: operatorDeniedReason(call.name) };
        return rawInner.execute(call);
      },
      setResolveBase: (cwd: string) => rawInner.setResolveBase?.(cwd),
      setAllowAll: (allow: boolean) => rawInner.setAllowAll?.(allow),
    };
    return wrapped;
  }

  const wrapped: GuardedDispatcher = {
    [OPERATOR_DENIED_BRAND]: true,
    operatorDenied: denied,
    _rawInner: inner,
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
