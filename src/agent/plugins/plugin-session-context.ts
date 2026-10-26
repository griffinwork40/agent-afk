/**
 * Process-global AsyncLocalStorage carrying the trusted session id of the
 * session currently executing a plugin hook or plugin tool call.
 *
 * Extracted into its own module to break the circular import that would arise
 * if `load-entrypoints` (which needs the ALS to wrap hook dispatch) imported
 * `skill-bridge` (which imports `load-entrypoints` to call
 * `loadPluginEntrypoints` and `registerPluginHook`).
 *
 * Consumers:
 *   - `skill-bridge.ts` — exports {@link runWithPluginSessionContext} from
 *     here as the public API surface; the `listSessions` and `sendToSession`
 *     closures read from {@link pluginSessionContext} via `getStore()`.
 *   - `load-entrypoints.ts` — wraps each plugin hook invocation with
 *     {@link runWithPluginSessionContext} using the session id from the hook
 *     context, giving the plugin API methods a trusted caller identity.
 *
 * Process-global because the plugin entrypoint API is also process-global
 * (entrypoints are loaded once and their closures are reused across all
 * sessions on multi-session surfaces like the daemon and Telegram bot).
 * AsyncLocalStorage correctly scopes the value to each async call chain
 * without threading sessionId through every call site.
 *
 * @module agent/plugins/plugin-session-context
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Stores the trusted session id for the currently-executing plugin call chain.
 * `undefined` means no trusted context is set — callers that require a session
 * id must fail closed rather than guessing.
 */
export const pluginSessionContext = new AsyncLocalStorage<string | undefined>();

/**
 * Run `fn` within a plugin session context that carries `sessionId` as the
 * trusted caller identity.
 *
 * Plugin API methods that need to know who is calling (listSessions
 * self-exclusion, sendToSession from-binding) read from this store via
 * `pluginSessionContext.getStore()`. Call this around any plugin hook or tool
 * dispatch where the session id is known and trusted.
 *
 * When `sessionId` is `undefined` (legacy or synthetic hook context where no
 * session id is available), the ALS is still entered with `undefined` as the
 * value — this clears any outer context inherited via async propagation and
 * ensures peer API methods fail closed rather than accidentally inheriting an
 * ancestor session id. A nested missing-context call therefore cannot read
 * an outer caller's identity.
 *
 * Exported for the tool-dispatch layer and hook-install layer; not for plugin
 * code (plugins receive the already-bound API closures, never the raw ALS).
 */
export function runWithPluginSessionContext<T>(sessionId: string | undefined, fn: () => T): T {
  return pluginSessionContext.run(sessionId, fn);
}
