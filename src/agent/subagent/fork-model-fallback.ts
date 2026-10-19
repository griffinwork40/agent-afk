/**
 * Fork-time construction of a handle's default-tier model fallback (see
 * ./handle.model-fallback.ts for the run-time half and the full contract).
 *
 * Contract: returns `undefined` (no fallback) when the caller did not declare
 * one, when the fallback model equals the child's model, or when the child's
 * pre-built provider belongs to a different provider family than the
 * fallback model and the caller supplied no `buildProvider` to rebuild it —
 * reusing a foreign-family provider would route the retry to the wrong
 * backend, so we fail closed rather than guess.
 *
 * The replacement config is the already-assembled child config with ONLY the
 * model-bound fields replaced: model, credential (resolved for the fallback
 * model's OWN provider, with the same parent-credential anti-leak gates as a
 * normal fork), baseUrl, provider, and the journal meta. The abort signal,
 * budgets, preambles, cwd/read/write scopes and subagentId are inherited, so
 * the retry stays inside the same delegation budget and abort graph.
 *
 * @module agent/subagent/fork-model-fallback
 */

import { AgentSession } from '../session.js';
import type { AgentConfig } from '../types.js';
import type { ModelProvider } from '../provider.js';
import type { BundledProviderName } from '../providers/index.js';
import { providerForModel } from '../providers/index.js';
import { resolveCredentialForModel } from '../auth/credential-resolver.js';
import { applyManagerApiKeyFallback, applyParentCredentialFallback } from '../tools/child-credential.js';
import { buildPhaseRestrictedProvider } from '../tools/nesting.js';
import type { ForkSubagentOptions } from './fork-types.js';
import type { WorkspaceStore } from '../workspace/workspace-store.js';
import type { HandleModelFallback } from './handle.model-fallback.js';

export interface BuildForkModelFallbackArgs<T> {
  options: ForkSubagentOptions<T>;
  childConfig: AgentConfig;
  id: string;
  parentApiKey: string | undefined;
  parentBaseUrl: string | undefined;
  parentProvider: BundledProviderName | undefined;
  workspaceStore: WorkspaceStore | undefined;
}

export function buildForkModelFallback<T>(args: BuildForkModelFallbackArgs<T>): HandleModelFallback | undefined {
  const { options, childConfig, id } = args;
  const spec = options.modelFallback;
  if (spec === undefined) return undefined;
  const fromModel = String(childConfig.model);
  const toModel = spec.model;
  if (toModel === '' || toModel === fromModel) return undefined;
  const sameFamily = providerForModel(fromModel) === providerForModel(toModel);
  // How the retry gets its provider: a read-only phase rebuilds the phase
  // provider; a caller-built provider is rebuilt via `buildProvider`, or reused
  // only when it is the same family; no provider → the session routes itself.
  const rebuildProvider: (() => ModelProvider | undefined) | undefined =
    options.phaseRole === 'read-only'
      ? () => buildPhaseRestrictedProvider('read-only', toModel, args.workspaceStore)
      : childConfig.provider === undefined
        ? () => undefined
        : spec.buildProvider !== undefined
          ? () => spec.buildProvider!(toModel)
          : sameFamily
            ? () => childConfig.provider
            : undefined;
  // Foreign-family pre-built provider with no rebuild: fail closed (no fallback).
  if (rebuildProvider === undefined) return undefined;
  const createSession = (): AgentSession => {
    const resolved = applyParentCredentialFallback({
      childModel: toModel,
      resolved: resolveCredentialForModel(toModel),
      parentApiKey: args.parentApiKey,
    });
    const rebuilt = rebuildProvider();
    const toOpenAI = providerForModel(toModel) === 'openai-compatible';
    const config: AgentConfig = {
      ...childConfig,
      model: toModel,
      apiKey: applyManagerApiKeyFallback({
        childModel: toModel,
        configApiKey: resolved,
        parentApiKey: args.parentApiKey,
        parentProvider: args.parentProvider,
      }),
      baseUrl: toOpenAI ? undefined : args.parentBaseUrl,
      provider: rebuilt,
      messageJournal: options.parent.messageJournal?.forSubagent(id, { model: toModel, provider: rebuilt?.name ?? providerForModel(toModel) }),
    };
    if (rebuilt === undefined) delete config.provider;
    return new AgentSession(config);
  };
  return { fromModel, toModel, createSession };
}
