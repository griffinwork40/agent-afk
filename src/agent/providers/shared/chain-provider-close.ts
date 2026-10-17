import type { ProviderQuery } from '../../provider.js';

/**
 * Invariant: chain `closeProvider` onto `query.close()` exactly once per query
 * handle (#3532, #3567).
 *
 * AgentSession.close() calls providerQuery.close() but never provider.close(),
 * so without this chain the provider's owned SQLite stores (kv.db, memory)
 * leak and Windows rmSync hits EBUSY. Providers recreate owned stores lazily
 * on the next query, so a stale `q1.close()` issued after `q2 = query()` must
 * be a no-op: re-running closeProvider would close q2's fresh stores. The
 * closure-local flag makes the wrapper idempotent per handle.
 *
 * Invariant (store lifetime, governs ordering): `closeProvider` runs when ANY
 * session using this provider closes, including a forked child while its
 * siblings are still being created. The caller-injected stores (the REPL's
 * single WorkspaceStore / MemoryStore / StateStore, shared by the root and
 * every child provider) must outlive all of those sessions, because the
 * next fork reads the WorkspaceStore in buildForkChildConfig
 * (subagent/fork-child-config.ts) before its child session exists. So
 * `closeProvider` may release only stores the provider created lazily; the
 * surface that created a shared store closes it after the whole tree has
 * drained (#3559). Violating this fails every later fork with "Failed to
 * fork subagent: The database connection is not open". Pinned by
 * tools/child-provider-close-workspace.test.ts and
 * providers/provider-close-ownership.test.ts.
 */
export function chainProviderClose<Q extends ProviderQuery>(query: Q, closeProvider: () => void): Q {
  let closed = false;
  const origClose = query.close.bind(query);
  query.close = (): void => {
    if (closed) return;
    closed = true;
    origClose();
    closeProvider();
  };
  return query;
}
