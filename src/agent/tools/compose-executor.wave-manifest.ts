/**
 * `buildComposeWaveManifest` — crash-recovery manifest creation for compose
 * DAG dispatches. Split out of `compose-executor.ts` (file-size ceiling, #3481).
 *
 * @module agent/tools/compose-executor.wave-manifest
 */

import {
  buildWaveUnit,
  createManifest,
} from '../manifest/write.js';
import { resolveChildModel } from '../subagent/resolve-child-model.js';
import type { ComposeInput } from './compose-input-parse.js';
import type { AgentModelInput } from '../types.js';
import type { AgentRegistry } from '../agents/index.js';

export interface BuildComposeWaveManifestArgs {
  parsed: ComposeInput;
  dagNodeCount: number;
  depth: number | undefined;
  currentCwd: string | undefined;
  defaultModel: AgentModelInput | undefined;
  defaultSubagentModel: AgentModelInput;
  parentSessionId: string | undefined;
  agentRegistry: AgentRegistry | undefined;
}

/**
 * Build and register a wave-manifest for crash-recovery. Called from
 * `ComposeExecutor.execute()` when ≥2 DAG nodes are present and depth is 0.
 *
 * @returns The new wave-manifest id, or `undefined` when the conditions for
 *   manifest creation are not met (solo dispatch, non-zero depth, or any
 *   manifest write error — manifest errors must never abort a compose wave).
 */
export function buildComposeWaveManifest(args: BuildComposeWaveManifestArgs): string | undefined {
  const { parsed, dagNodeCount, depth, currentCwd, defaultModel, defaultSubagentModel, parentSessionId, agentRegistry } = args;
  // No manifest for solo dispatch or subagent-depth compose calls.
  if (dagNodeCount < 2 || (depth ?? 0) !== 0) return undefined;
  try {
    const manifestUnits = parsed.nodes.map((n) => {
      // Per-node cwd overrides the parent session's cwd for the manifest,
      // so crash-recovery records the correct working directory per node.
      const effectiveCwd = n.cwd ?? currentCwd;
      // Named-agent model default: same precedence logic as dagNodes above
      // (call-site > definition > compose default). Required so crash-recovery
      // manifests record the same effective model the DAG node would use.
      const manifestNamedAgent = n.agent_type !== undefined
        ? agentRegistry?.get(n.agent_type)
        : undefined;
      const rawManifestDefModel = manifestNamedAgent?.definition.model;
      const manifestDefinitionModel = rawManifestDefModel === 'inherit'
        ? defaultModel
        : rawManifestDefModel;
      return buildWaveUnit({
        id: n.id,
        prompt: n.prompt,
        cwd: effectiveCwd,
        model: resolveChildModel({
          callSiteModel: n.model ?? manifestDefinitionModel,
          defaultSubagentModel,
          defaultModel,
        }),
      });
    });
    // Build upstream-id map from edges: for each node, list its upstream deps.
    const upstreamMap = new Map<string, string[]>();
    for (const node of parsed.nodes) upstreamMap.set(node.id, []);
    for (const edge of parsed.edges ?? []) {
      const list = upstreamMap.get(edge.to);
      if (list !== undefined) list.push(edge.from);
    }
    for (const unit of manifestUnits) {
      unit.upstreamIds = upstreamMap.get(unit.id) ?? [];
    }
    return createManifest({
      source: 'compose-dag',
      parentSessionId: parentSessionId ?? '',
      traceLabel: null,
      units: manifestUnits,
    });
  } catch {
    // Fire-and-forget: manifest errors must never abort a compose wave.
    return undefined;
  }
}
