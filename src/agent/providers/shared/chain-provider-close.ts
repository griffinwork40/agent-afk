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
