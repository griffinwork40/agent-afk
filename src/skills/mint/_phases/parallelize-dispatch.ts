/**
 * Phase 4: Dispatch /parallelize if plan has ≥3 files.
 * Checks if the plan mentions 3+ files and dispatches the parallelize skill.
 *
 * Returns a discriminated union so the caller can distinguish:
 *   - 'skipped' — parallelism not needed (legitimate no-op)
 *   - 'plan'    — orchestration plan produced
 *   - 'failed'  — dispatch was attempted but failed (silent degradation prevented)
 *
 * Previously this returned `null` for both the legitimate skip and the
 * silent-failure paths, which made degraded runs indistinguishable from
 * "parallelism unnecessary" in the persisted history and downstream phases.
 * See docs/audits/orchestration-pressure-audit.md §F.1 / §D ("Silent inline
 * fallback after delegation failure is forbidden").
 */

import { getSkill } from '../../index.js';
import { discoverPluginSkillBodies } from '../../../agent/tools/skill-bridge.js';
import { SubagentManager } from '../../../agent/subagent.js';
import { resolveCredentialForModel } from '../../../agent/auth/credential-resolver.js';
import type { AgentModelInput, IAgentSession } from '../../../agent/types.js';

export type ParallelizeDispatchResult =
  | { kind: 'skipped'; reason: 'too-few-files' | 'skill-body-missing' }
  | { kind: 'plan'; plan: unknown }
  | { kind: 'failed'; error: string };

/**
 * Count distinct file references in plan text.
 *
 * Extracts tokens that look like file paths (have a recognized source/doc
 * extension) and returns the count of *unique* paths. A prior implementation
 * combined two heuristics (an extension regex AND a `Files:`-list parser) and
 * summed their hit counts, which double-counted any path that appeared in a
 * `Files:` list and also matched the extension regex (e.g. `Files: a.ts,
 * b.ts\n…` scored 3 for a genuinely 2-file plan and falsely tripped the
 * `< 3` dispatch gate). Deduplicating via a Set fixes that — see PR #152
 * review finding M-1.
 */
function countFileReferences(plan: string): number {
  // A path token: anything containing `/` or starting non-whitespace, ending
  // in one of the recognized extensions. Anchored on word boundaries / list
  // separators so trailing punctuation in prose (e.g. "src/a.ts.") still
  // contributes one path.
  const pathPattern = /[\w./@-]*\.(?:ts|tsx|js|jsx|mjs|cjs|py|md|json|yaml|yml|toml|sh)\b/gi;
  const paths = new Set<string>();
  for (const match of plan.matchAll(pathPattern)) {
    paths.add(match[0].toLowerCase());
  }
  return paths.size;
}

export async function runParallelizeDispatch(
  plan: string,
  parentSession: IAgentSession,
  // Mint skill's ToolCall id — anchors the parallelize subagent under the
  // mint skill's tool-lane entry. See skills/index.ts SkillExecutionContext.callId.
  skillCallId?: string,
  defaultSubagentModel: AgentModelInput = 'sonnet',
  // Read-scope inheritance (#547): parent session's read roots (resolved once
  // by the mint handler); seeds the fork manager's parentReadRoots so the
  // parallelize subagent's reads ⊇ the parent session's. Undefined leaves
  // cwd-derivation intact.
  parentReadRoots?: string[],
): Promise<ParallelizeDispatchResult> {
  const fileCount = countFileReferences(plan);

  if (fileCount < 3) {
    return { kind: 'skipped', reason: 'too-few-files' };
  }

  // Try registry first (covers user-installed TS skill overrides).
  // Registry hits are treated as authoritative — if the registered handler
  // throws, surface the failure rather than silently falling through to the
  // plugin-body path (which would mask a real bug in the user's override).
  let registryHit = false;
  try {
    const parallelize = getSkill('parallelize');
    registryHit = true;
    const waveOrchestration = await parallelize.handler({ plan });
    return { kind: 'plan', plan: waveOrchestration };
  } catch (err) {
    if (registryHit) {
      return {
        kind: 'failed',
        error: `parallelize skill handler threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    // Not in registry — fall through to plugin/bundled body dispatch.
  }

  // Fall back to plugin skill body (bundled or user-installed plugin).
  try {
    const bodies = discoverPluginSkillBodies();
    const skill = bodies.get('parallelize');
    if (!skill) {
      // No skill body available at all — this is a legitimate "we cannot
      // parallelize here" rather than a dispatch failure. The build phase
      // can proceed single-lane without complaint.
      return { kind: 'skipped', reason: 'skill-body-missing' };
    }

    // Propagate parent worktree — the parallelize subagent itself doesn't
    // mutate files, but threading cwd keeps behavior consistent and avoids
    // surprise if it ever shells out to inspect the working tree.
    const manager = new SubagentManager({
      parentAbortSignal: parentSession.abortSignal,
      ...(parentSession.cwd !== undefined ? { cwd: parentSession.cwd } : {}),
      ...(parentReadRoots !== undefined ? { parentReadRoots } : {}),
    });
    try {
      // PLUGIN_ROOT injection mirrors `executePluginSkill` — see
      // skill-executor.ts. Even though the parallelize skill body
      // currently has no shell snippets, threading the env keeps the
      // dispatch path symmetric and future-proofs against added scripts.
      const handle = await manager.forkSubagent({
        // Bare parent (sessionId only) — matches every other mint phase fork.
        // Passing the full session would expose its hookRegistry, which
        // SubagentManager.forkSubagent now resolves from the parent: that would
        // fire SubagentStart/completion (and, absent the fragile 'mint' substring
        // match on idPrefix, a stray shadow-verify nudge) for this internal
        // sub-step. Mint internals stay dark; only the top-level mint dispatch
        // surfaces lifecycle to the user.
        parent: { sessionId: parentSession.sessionId },
        config: {
          model: defaultSubagentModel,
          systemPrompt: skill.body,
          env: { PLUGIN_ROOT: skill.pluginPath },
          // Resolve the child's credential off ITS OWN model, not the ambient
          // top-level model — matches the other 7 mint phase forks (#431/#378).
          // Fixes #444: this was the last site still keying off getApiKey()/
          // AFK_MODEL, which left the fork credential-less under a cross-provider
          // operator and silently degraded parallelize to single-lane.
          apiKey: resolveCredentialForModel(defaultSubagentModel),
        },
        idPrefix: 'mint-parallelize',
        agentType: 'mint-parallelize',
        ...(skillCallId ? { parentId: skillCallId } : {}),
      });
      const result = await handle.runToResult(JSON.stringify({ plan }));
      if (result.status === 'succeeded' && result.message) {
        return { kind: 'plan', plan: result.message.content };
      }
      if (result.status !== 'succeeded') {
        return {
          kind: 'failed',
          error: `parallelize subagent status=${result.status}${
            result.error?.message ? `: ${result.error.message}` : ''
          }`,
        };
      }
      // succeeded but no message — treat as failure: we cannot use an empty plan.
      return { kind: 'failed', error: 'parallelize subagent returned no message' };
    } finally {
      await manager.teardownAll();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'failed', error: `parallelize dispatch threw: ${message}` };
  }
}
