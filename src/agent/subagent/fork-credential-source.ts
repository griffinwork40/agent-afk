/**
 * Credential-source id for a forked child's `subagent_lifecycle.started`
 * payload (#4882).
 *
 * Contract: best-effort observability. Resolves the provider-aware source id
 * for the child's model via {@link resolveCredentialSourceForModel} (ids only,
 * never token material). Skipped entirely when there is no trace writer — the
 * id has nowhere to go — and any resolver failure yields `undefined` (field
 * absent) rather than breaking the fork.
 *
 * @module agent/subagent/fork-credential-source
 */

import type { TraceSink } from '../trace/index.js';
import type { AgentModelInput } from '../types.js';
import { resolveCredentialSourceForModel } from '../auth/credential-source.js';

/** Resolve the source id for `model` when a trace writer will record it. */
export function traceCredentialSource(
  traceWriter: TraceSink | undefined,
  model: AgentModelInput | undefined,
): string | undefined {
  if (traceWriter === undefined || typeof model !== 'string' || model.length === 0) return undefined;
  try {
    return resolveCredentialSourceForModel(model);
  } catch {
    return undefined;
  }
}
