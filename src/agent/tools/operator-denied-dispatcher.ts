import { isToolDenied, snapshotOperatorPermissions } from './operator-denied.js';
import { builtinToolSchemas } from './schemas.js';
import type { ToolPermissionConfig } from './permissions.js';
import type { AnthropicToolDef, ToolCall, ToolDispatcher, ToolResult } from '../providers/anthropic-direct/types.js';

export { withOperatorDenied } from './operator-denied.js';
export { withMcpToolsAllowed, withCustomToolsAllowed, type ToolPermissionConfig } from './permissions.js';

type CatalogDispatcher = ToolDispatcher & { readonly toolDefs?: readonly AnthropicToolDef[] };

/** Wrap consumer-owned dispatchers so operator hygiene is not bypassed by opts.tools. */
export function withOperatorDeniedDispatcher(
  inner: ToolDispatcher | undefined,
  permissions: ToolPermissionConfig | undefined,
): ToolDispatcher | undefined {
  if (!inner || !permissions?.deniedTools?.length) return inner;
  const denied = permissions.deniedTools;
  const wrapped: CatalogDispatcher = {
    get toolDefs() {
      return ((inner as CatalogDispatcher).toolDefs ?? builtinToolSchemas).filter((s) => !isToolDenied(s.name, denied));
    },
    async execute(call: ToolCall): Promise<ToolResult> {
      if (isToolDenied(call.name, denied)) return {
        isError: true,
        content: `Tool "${call.name}" is disabled by operator settings (tools.disabled in afk.config.json).`,
      };
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

/** Return a dispatcher's advertised catalog, including guarded external dispatchers. */
export function operatorDispatcherToolDefs(dispatcher: ToolDispatcher, fallback: readonly AnthropicToolDef[]): readonly AnthropicToolDef[] {
  return (dispatcher as CatalogDispatcher).toolDefs ?? fallback;
}
