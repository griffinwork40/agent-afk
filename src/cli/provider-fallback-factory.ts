/**
 * Provider wiring for surfaces that inject a ready-made provider into their
 * session (one-shot `chat`, the daemon) and also want `models.fallback`.
 *
 * Contract: the surface supplies ONE build function. The primary provider and
 * any provider the session later switches to both come out of it, so a
 * fallback carries the same executors, stores, MCP manager and tool allowlist
 * as the provider it replaces. The result spreads into the `AgentSession`
 * config: `provider` always, `providerFactory` only when the operator has not
 * pinned a provider.
 *
 * A pinned provider (`--provider` or `AFK_PROVIDER`) forces one family for
 * every model, so a fallback on another provider could only be sent to the
 * wrong backend. With no factory the session keeps today's direct path and
 * never switches.
 *
 * The cache is per call, so per session. Never hoist it: the daemon builds a
 * session per task, and a shared instance would carry one task's provider
 * state into the next.
 *
 * @module cli/provider-fallback-factory
 */
import type { ModelProvider } from '../agent/provider.js';
import { env } from '../config/env.js';
import { createMemoizedProviderFactory } from './commands/interactive/provider-factory.js';

export interface InjectedProviderWiring {
  provider: ModelProvider;
  providerFactory?: (model: string | undefined) => ModelProvider;
}

export interface InjectedProviderArgs {
  /** The session's primary model. */
  model: string;
  /** An explicit `--provider` value, when the surface accepts one. */
  explicitProvider?: string | undefined;
  /** Build a fully wired provider for `model`. */
  build: (model: string) => ModelProvider;
  /** The provider family `build` constructs for `model` (the cache key). */
  familyOf: (model: string) => string;
}

/** True when the operator fixed the provider family for every model. */
export function isProviderPinned(explicitProvider: string | undefined): boolean {
  return (explicitProvider ?? '').trim() !== '' || (env.AFK_PROVIDER ?? '').trim() !== '';
}

/** Build the primary provider and, unless pinned, the factory for a fallback. */
export function injectedProviderWiring(args: InjectedProviderArgs): InjectedProviderWiring {
  const providerFactory = createMemoizedProviderFactory(
    (model) => args.build(model ?? args.model),
    (model) => args.familyOf(model ?? args.model),
  );
  const provider = providerFactory(args.model);
  return isProviderPinned(args.explicitProvider) ? { provider } : { provider, providerFactory };
}
