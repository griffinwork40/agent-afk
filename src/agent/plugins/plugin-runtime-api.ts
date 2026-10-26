/**
 * Plugin runtime API factory.
 *
 * Constructs the {@link PluginApi} state-store and peer-messaging closures that
 * are injected into plugin entrypoints via {@link ensurePluginEntrypointsLoaded}.
 *
 * Extracted from `skill-bridge.ts` to keep that module near its prior size and
 * to allow `load-entrypoints.ts` to import the ALS store directly without
 * creating a circular dependency through `skill-bridge`.
 *
 * The state store singleton is owned here: a single lazily-opened SQLite
 * connection shared across all plugin state calls in this host process.
 *
 * @module agent/plugins/plugin-runtime-api
 */

import { makeDefaultStateStore } from '../providers/shared/provider-stores.js';
import { sendToSession as _sendToSession } from '../peer/send.js';
import type { SendInput } from '../peer/send.js';
import { readLivePresenceFiles } from '../awareness/presence.js';
import { pluginSessionContext } from './plugin-session-context.js';
import type { PluginApi } from './load-entrypoints.js';

// ---------------------------------------------------------------------------
// State store singleton — opened on first use, reused across all callers.
// ---------------------------------------------------------------------------

let _defaultStateStore: ReturnType<typeof makeDefaultStateStore> | undefined;

/**
 * Return the process-owned default StateStore, creating it on first call.
 * Accepts an optional factory for test injection.
 */
export function getOrCreateDefaultStateStore(
  factory: () => ReturnType<typeof makeDefaultStateStore> = makeDefaultStateStore,
): ReturnType<typeof makeDefaultStateStore> {
  if (_defaultStateStore === undefined) {
    _defaultStateStore = factory();
  }
  return _defaultStateStore;
}

/** Reset the singleton — for tests only. */
export function _resetDefaultStateStore(): void {
  _defaultStateStore = undefined;
}

// ---------------------------------------------------------------------------
// API closure builders
// ---------------------------------------------------------------------------

/**
 * Build the state-store slice of {@link PluginApi}.
 *
 * @param pluginId - Plugin name from the manifest (e.g. `"afk-moat"`). When
 *   provided, every namespace is prefixed with `plugin:<pluginId>:` so plugins
 *   are sandboxed and cannot read or write host-owned namespaces.
 *   When omitted (legacy / test callers) namespaces are passed verbatim.
 * @param factory - Optional factory override for the default StateStore, used
 *   for test injection. When omitted the process singleton is used.
 */
export function buildStateApiClosures(
  pluginId?: string,
  factory?: () => ReturnType<typeof makeDefaultStateStore>,
): Pick<
  Required<PluginApi>,
  'stateGet' | 'statePut' | 'stateCas' | 'stateDel' | 'stateInsertIfAbsent' | 'stateQuery'
> {
  const store = () => getOrCreateDefaultStateStore(factory);
  // Invariant: plugin namespace sandboxing. All state operations for a
  // code-backed plugin are scoped to `plugin:<pluginId>:` so a plugin
  // cannot read, write, or delete host-owned namespaces (e.g. `usage`,
  // `presence`, peer-inbox namespaces). When pluginId is absent the raw
  // namespace is forwarded — only used by tests and legacy call sites that
  // do not supply a plugin identity.
  const scope = (ns: string): string =>
    pluginId !== undefined && pluginId.length > 0 ? `plugin:${pluginId}:${ns}` : ns;
  return {
    stateGet: (ns, key) => store().get(scope(ns), key),
    statePut: (ns, key, value, opts) => store().put(scope(ns), key, value, opts),
    stateCas: (ns, key, ev, value, opts) => store().cas(scope(ns), key, ev, value, opts),
    stateDel: (ns, key) => store().del(scope(ns), key),
    stateInsertIfAbsent: (ns, key, value, opts) => store().insertIfAbsent(scope(ns), key, value, opts),
    stateQuery: (ns, opts) => store().query(scope(ns), opts),
  };
}

/**
 * Build the peer-messaging slice of {@link PluginApi}.
 *
 * Both methods require a trustworthy ALS context (set by
 * {@link runWithPluginSessionContext}) and fail closed with a descriptive
 * error when none is present, rather than silently using a wrong identity.
 */
export function buildPeerApiClosures(): Pick<Required<PluginApi>, 'listSessions' | 'sendToSession'> {
  return {
    listSessions: async () => {
      const selfId = pluginSessionContext.getStore();
      if (selfId === undefined) {
        throw new Error(
          '[plugin] listSessions requires a trustworthy caller context. ' +
          'Call runWithPluginSessionContext(sessionId, ...) before invoking plugin API methods.',
        );
      }
      const records = await readLivePresenceFiles();
      return records.filter((r) => r.sessionId !== selfId);
    },

    sendToSession: async (input: Omit<SendInput, 'from'>) => {
      const selfId = pluginSessionContext.getStore();
      if (selfId === undefined) {
        throw new Error(
          '[plugin] sendToSession requires a trustworthy caller context. ' +
          'Call runWithPluginSessionContext(sessionId, ...) before invoking plugin API methods.',
        );
      }
      return _sendToSession({ ...input, from: { id: selfId } });
    },
  };
}
