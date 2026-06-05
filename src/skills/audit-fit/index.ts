/**
 * /audit-fit skill — audits ~/.afk artifacts for correct type categorization.
 *
 * Discovers artifacts deterministically in TypeScript (user-scope from
 * `~/.afk/{skills,commands,agents}/`, plugin-scope via `scanLocalPlugins`,
 * hooks from `~/.afk/settings.json`), splits them by source, and forks
 * per-type inspector subagents that read the pre-discovered list and emit
 * verdicts. The synthesis layer aggregates verdicts into a nested inventory
 * matrix (`user` × `plugin`) and writes migration briefs only for
 * high-confidence user-scope misfits — plugin-scope misfits are inventory
 * only because refactoring vendored plugin code is the maintainer's job.
 *
 * @module skills/audit-fit
 */

import { z } from 'zod';
import { mkdir, appendFile } from 'fs/promises';
import { join } from 'path';
import { loadSkillPrompts } from '../_lib/prompt-loader.js';
import { registerSkill, type SkillExecutionContext, type SkillMetadata } from '../index.js';
import { SubagentManager } from '../../agent/subagent.js';
import type { SubagentResult } from '../../agent/subagent/result.js';
import { runWave } from '../../agent/subagent/wave.js';
import type { IAgentSession } from '../../agent/types.js';
import type { CanUseTool } from '../../agent/types/sdk-types.js';
import { researchAgent } from '../_agents/research-agent.js';
import { getAfkHome, getAgentFrameworkDir, getBriefsDir } from '../../paths.js';
import {
  discoverUserScope,
  discoverPluginScope,
  discoverHooks,
  type DiscoveredArtifact,
  type DiscoveredHook,
  type ArtifactType,
} from './discover.js';

/**
 * Schema for a single artifact verdict.
 *
 * `source` distinguishes user-authored artifacts (`~/.afk/{skills,commands,agents}/`)
 * from plugin-shipped artifacts (`~/.afk/plugins/<plugin>/{skills,commands,agents}/`).
 * `plugin_key` is set only when `source === 'plugin'` and identifies the plugin
 * via the same key shape used by `plugins-scanner`'s `indexKeyForPath`
 * (e.g., `"data"` for flat layout, `"<marketplace>:<plugin>"` for cache layout).
 */
export const VerdictSchema = z.object({
  path: z.string(),
  type: z.enum(['skill', 'command', 'agent', 'hook']),
  source: z.enum(['user', 'plugin']),
  plugin_key: z.string().optional(),
  verdict: z.enum(['correct', 'misfit', 'outlier']),
  recommended_type: z.string(),
  rationale: z.string(),
  confidence: z.enum(['high', 'med', 'low']),
});

export type Verdict = z.infer<typeof VerdictSchema>;

/**
 * Inventory matrix shape: type → verdict-category → count.
 * Hooks always live under the user-scope inventory.
 */
export const InventoryMatrixSchema = z.record(
  z.string(),
  z.record(z.string(), z.number()),
);

export type InventoryMatrix = z.infer<typeof InventoryMatrixSchema>;

/**
 * Schema for the complete audit-fit result.
 * Inventory is split into user-scope and plugin-scope sub-matrices.
 */
export const AuditFitResultSchema = z.object({
  inventory: z.object({
    user: InventoryMatrixSchema,
    plugin: InventoryMatrixSchema,
  }),
  misfits: z.array(VerdictSchema),
  briefs_written: z.number(),
  total_artifacts: z.number(),
});

export type AuditFitResult = z.infer<typeof AuditFitResultSchema>;

/**
 * Input schema for the /audit-fit skill.
 *
 * - `writeBriefs` (default true): generate migration briefs for high-confidence
 *   user-scope misfits. Plugin-scope misfits never produce briefs regardless of
 *   this flag (refactoring vendored plugin code is the maintainer's job).
 * - `scope` (default 'all'): restrict the audit. `'plugin'` skips the hook
 *   inspector since hooks are user-scope only.
 */
export const AuditFitInputSchema = z.object({
  writeBriefs: z.boolean().optional(),
  scope: z.enum(['user', 'plugin', 'all']).optional(),
});

export type AuditFitInput = z.infer<typeof AuditFitInputSchema>;

type Scope = 'user' | 'plugin' | 'all';
type Source = 'user' | 'plugin';
type FullArtifactType = 'skill' | 'command' | 'agent' | 'hook';
type VerdictCategory = 'correct' | 'misfit' | 'outlier';

const FILE_TYPES: ReadonlyArray<ArtifactType> = ['skill', 'command', 'agent'];
const ALL_TYPES: ReadonlyArray<FullArtifactType> = [
  'skill',
  'command',
  'agent',
  'hook',
];

/**
 * Decide which discovery phases and inspectors run for a given scope.
 * Pure function — exported for testing.
 */
export function planAuditScope(scope: Scope): {
  runUserDiscovery: boolean;
  runPluginDiscovery: boolean;
  runHookInspector: boolean;
} {
  return {
    runUserDiscovery: scope !== 'plugin',
    runPluginDiscovery: scope !== 'user',
    runHookInspector: scope !== 'plugin',
  };
}

/**
 * Aggregate a flat list of verdicts into the nested inventory matrix
 * (source × type × verdict-category) plus a misfits list sorted by confidence.
 * Pure function — exported for testing.
 */
export function aggregateVerdicts(verdicts: ReadonlyArray<Verdict>): {
  inventory: AuditFitResult['inventory'];
  misfits: Verdict[];
} {
  const makeMatrix = (): Record<FullArtifactType, Record<VerdictCategory, number>> => {
    const m = {} as Record<FullArtifactType, Record<VerdictCategory, number>>;
    for (const t of ALL_TYPES) {
      m[t] = { correct: 0, misfit: 0, outlier: 0 };
    }
    return m;
  };
  const inventory = { user: makeMatrix(), plugin: makeMatrix() };
  for (const v of verdicts) {
    inventory[v.source][v.type][v.verdict] += 1;
  }
  const confidenceOrder: Record<Verdict['confidence'], number> = {
    high: 0,
    med: 1,
    low: 2,
  };
  const misfits = verdicts
    .filter((v) => v.verdict === 'misfit')
    .slice()
    .sort((a, b) => confidenceOrder[a.confidence] - confidenceOrder[b.confidence]);
  return { inventory, misfits };
}

/**
 * Predicate: should this misfit produce a migration brief?
 * Only high-confidence user-scope misfits get briefs — plugin-scope misfits
 * never do, because the user doesn't own that code.
 * Pure function — exported for testing.
 */
export function shouldWriteBriefForMisfit(m: Verdict): boolean {
  return m.verdict === 'misfit' && m.confidence === 'high' && m.source === 'user';
}

/**
 * Render a templated artifact list to append to an inspector prompt.
 */
function renderArtifactList(
  artifacts: ReadonlyArray<DiscoveredArtifact>,
): string {
  const userScope = artifacts.filter((a) => a.source === 'user');
  const pluginScope = artifacts.filter((a) => a.source === 'plugin');
  const out: string[] = ['', '## Discovered artifacts (audit only these)', ''];

  out.push('### User-scope artifacts (set `"source": "user"`, omit `plugin_key`)');
  if (userScope.length === 0) {
    out.push('(none discovered)');
  } else {
    for (const a of userScope) out.push(`- ${a.path}`);
  }

  out.push('');
  out.push(
    '### Plugin-scope artifacts (set `"source": "plugin"`, copy `plugin_key` from each entry)',
  );
  if (pluginScope.length === 0) {
    out.push('(none discovered)');
  } else {
    for (const a of pluginScope) {
      const key = a.plugin_key ?? '<unknown>';
      out.push(`- ${a.path}  (plugin_key: ${key})`);
    }
  }
  return out.join('\n');
}

/**
 * Render a templated hook list to append to the hook inspector prompt. The
 * absolute settings.json path goes inline so the inspector never has to expand
 * `~/.afk/` against an unknown subagent $HOME — the original failure mode
 * resolved `~` to `/root` and dead-ended at `/root/.afk/settings.json`.
 */
export function renderHookList(
  settingsPath: string,
  hooks: ReadonlyArray<DiscoveredHook>,
): string {
  const out: string[] = ['', '## Discovered hooks (audit only these)', ''];
  out.push(
    `Settings file (use this absolute path verbatim in each verdict's \`path\` field): \`${settingsPath}\``,
  );
  out.push('');
  if (hooks.length === 0) {
    out.push('(no hooks discovered)');
    return out.join('\n');
  }
  for (const h of hooks) {
    const id = `${h.event}-${h.index}`;
    out.push(`### Hook \`${id}\``);
    out.push('');
    out.push('```json');
    out.push(JSON.stringify(h.raw, null, 2));
    out.push('```');
    out.push('');
  }
  return out.join('\n');
}

interface InspectorConfig {
  type: FullArtifactType;
  prompt: string;
  artifacts: ReadonlyArray<DiscoveredArtifact>;
  runPrompt: string;
}

/**
 * Outcome of validating a single inspector subagent's `SubagentResult`.
 * Either a one-line failure message (with cause) or the parsed verdicts ready
 * to aggregate.
 */
export type InspectorOutcome =
  | { kind: 'failure'; message: string }
  | { kind: 'success'; output: ReadonlyArray<Verdict> };

/**
 * Classify an inspector's result into a failure message or parsed verdicts.
 *
 * Order matters: `buildResultFromMessage` sets `status: 'failed'` AND populates
 * `schemaError` (with `error` left undefined) when `outputSchema.safeParse`
 * fails. So the schemaError branch must come before the generic status check
 * — otherwise the dedicated "schema mismatch" message gets swallowed by a
 * bare "<type>: failed".
 *
 * Pure function — exported for testing.
 */
export function classifyInspectorResult(
  type: FullArtifactType,
  result: SubagentResult<ReadonlyArray<Verdict>> | undefined,
): InspectorOutcome {
  if (!result) return { kind: 'failure', message: `${type}: no result` };
  if (result.schemaError) {
    return {
      kind: 'failure',
      message: `${type}: schema mismatch — ${result.schemaError.message}`,
    };
  }
  if (result.status !== 'succeeded') {
    const errSuffix = result.error ? ` — ${result.error.message}` : '';
    return {
      kind: 'failure',
      message: `${type}: ${result.status}${errSuffix}`,
    };
  }
  if (!result.output) return { kind: 'failure', message: `${type}: no output` };
  return { kind: 'success', output: result.output };
}

async function handler(
  input: unknown,
  parentSession?: IAgentSession,
  ctx?: SkillExecutionContext,
): Promise<AuditFitResult> {
  // Contract: no AFK_INTERNAL handler guard here — intentional. /audit-fit
  // audits the caller's own ~/.afk artifacts and writes briefs locally, so it
  // runs fine for anyone. Its `audience: 'internal'` tag hides it from
  // end-user surfaces for UX (end users have no use for the brief output),
  // not because dispatch would break. The tier gate is surfacing-only by
  // design; dispatch via getSkill()/the skill tool stays available.
  const apiKey = ctx?.apiKey;
  // Tool-use ID of the `skill` ToolCall that invoked this handler. Forwarded
  // as `parentId` to every forkSubagent call so the parallel inspector
  // `Agent(...)` rows nest under THIS skill's tool-lane entry both in the
  // live overlay and in the committed scrollback block. See
  // skills/index.ts SkillExecutionContext.callId for the contract.
  const skillCallId = ctx?.callId;
  // The slash bridge passes raw arg strings to every skill handler.
  // /audit-fit takes no positional args — string input is ignored, only
  // object input (programmatic invocation) is parsed.
  const inputObj = typeof input === 'object' && input !== null ? input : {};
  const parsed = AuditFitInputSchema.parse(inputObj);
  const writeBriefs = parsed.writeBriefs ?? true;
  const scope: Scope = parsed.scope ?? 'all';
  const plan = planAuditScope(scope);

  if (!parentSession?.sessionId) {
    throw new Error('audit-fit requires a parent session with sessionId');
  }
  const sessionId = parentSession.sessionId;

  const prompts = loadSkillPrompts('audit-fit');
  const promptByType: Record<FullArtifactType, string | undefined> = {
    skill: prompts['01-skill-inspector.md'],
    command: prompts['02-command-inspector.md'],
    agent: prompts['03-agent-inspector.md'],
    hook: prompts['04-hook-inspector.md'],
  };
  for (const t of ALL_TYPES) {
    if (!promptByType[t]) {
      throw new Error(`audit-fit skill missing inspector prompt for ${t}`);
    }
  }

  const userArtifacts = plan.runUserDiscovery ? discoverUserScope() : [];
  const pluginArtifacts = plan.runPluginDiscovery ? discoverPluginScope() : [];

  const byType: Record<ArtifactType, DiscoveredArtifact[]> = {
    skill: [],
    command: [],
    agent: [],
  };
  for (const a of [...userArtifacts, ...pluginArtifacts]) {
    byType[a.type].push(a);
  }

  const manager = new SubagentManager({ apiKey });
  const createCanUseTool = (): CanUseTool => async (toolName: string) => {
    if (!researchAgent.allowedTools.includes(toolName as never)) {
      return {
        behavior: 'deny',
        message: `Tool ${toolName} not allowed for audit-fit inspectors. Allowed tools: ${researchAgent.allowedTools.join(', ')}`,
      };
    }
    return { behavior: 'allow' };
  };

  const inspectorConfigs: InspectorConfig[] = [];
  for (const type of FILE_TYPES) {
    const artifacts = byType[type];
    if (artifacts.length === 0) continue;
    const basePrompt = promptByType[type];
    if (!basePrompt) continue;
    inspectorConfigs.push({
      type,
      prompt: `${basePrompt}\n${renderArtifactList(artifacts)}`,
      artifacts,
      runPrompt: `Inspect every ${type} listed in the artifact section.`,
    });
  }
  if (plan.runHookInspector) {
    const hookPrompt = promptByType['hook'];
    if (hookPrompt) {
      const settingsPath = join(getAfkHome(), 'settings.json');
      const hooks = discoverHooks(settingsPath);
      inspectorConfigs.push({
        type: 'hook',
        prompt: `${hookPrompt}\n${renderHookList(settingsPath, hooks)}`,
        artifacts: [],
        runPrompt: `Inspect every hook listed in the Discovered hooks section. Settings file: ${settingsPath}.`,
      });
    }
  }

  const allVerdicts: Verdict[] = [];

  if (inspectorConfigs.length > 0) {
    const handles = await Promise.all(
      inspectorConfigs.map((cfg) =>
        manager.forkSubagent({
          parent: { sessionId },
          config: {
            model: 'sonnet',
            systemPrompt: `${researchAgent.systemPrompt}\n\n${cfg.prompt}`,
            canUseTool: createCanUseTool(),
          },
          idPrefix: `inspector-${cfg.type}`,
          outputSchema: z.array(VerdictSchema),
          ...(skillCallId ? { parentId: skillCallId } : {}),
        }),
      ),
    );

    const results = await runWave(
      inspectorConfigs.map((cfg, i) => {
        const handle = handles[i];
        if (!handle) {
          throw new Error(`audit-fit: missing handle for ${cfg.type} inspector`);
        }
        return { handle, prompt: cfg.runPrompt };
      }),
      { failFast: false },
    );

    const failures: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const cfg = inspectorConfigs[i];
      if (!cfg) continue;
      const outcome = classifyInspectorResult(cfg.type, result);
      if (outcome.kind === 'failure') {
        failures.push(outcome.message);
        continue;
      }

      // Defensive: verdicts the inspector returns must match the source we
      // sent in (catches an inspector that fabricates a verdict for a path
      // outside the templated list, or flips its source).
      const expectedSource = new Map<string, Source>();
      for (const a of cfg.artifacts) expectedSource.set(a.path, a.source);

      for (const v of outcome.output) {
        if (cfg.type === 'hook') {
          if (v.source !== 'user') {
            failures.push(
              `${cfg.type}: hook verdict has source=${v.source} (must be 'user')`,
            );
            continue;
          }
        } else {
          const expected = expectedSource.get(v.path);
          if (expected === undefined) {
            failures.push(
              `${cfg.type}: verdict for unknown path ${v.path} (not in discovered list)`,
            );
            continue;
          }
          if (v.source !== expected) {
            failures.push(
              `${cfg.type}: verdict source mismatch for ${v.path} (expected ${expected}, got ${v.source})`,
            );
            continue;
          }
        }
        allVerdicts.push(v);
      }
    }

    if (failures.length > 0) {
      const failureMsg = failures.map((f) => `  - ${f}`).join('\n');
      throw new Error(
        `audit-fit: ${failures.length} inspector failure(s):\n${failureMsg}`,
      );
    }
  }

  const { inventory, misfits } = aggregateVerdicts(allVerdicts);

  let briefsWritten = 0;
  if (writeBriefs) {
    const briefsDir = getBriefsDir();
    await mkdir(briefsDir, { recursive: true });

    for (const misfit of misfits.filter(shouldWriteBriefForMisfit)) {
      const slug = misfit.path
        .replace(/[^a-z0-9]+/gi, '-')
        .toLowerCase()
        .slice(0, 30);
      const briefPath = join(briefsDir, `audit-fit-${slug}.md`);
      const briefContent = `---
theme: audit-fit
session_count: 1
---

# Audit: ${misfit.path}

**Current type:** ${misfit.type}
**Recommended type:** ${misfit.recommended_type}

## Rationale

${misfit.rationale}

## Migration Steps

1. Review the artifact in \`${misfit.path}\`
2. Evaluate the recommended change to \`${misfit.recommended_type}\`
3. If appropriate, refactor using the patterns in the public plugin documentation

---
Generated by audit-fit on ${new Date().toISOString().split('.')[0]}Z
`;
      await appendFile(briefPath, briefContent);
      briefsWritten++;
    }
  }

  const telemetryDir = getAgentFrameworkDir();
  await mkdir(telemetryDir, { recursive: true });

  const sumMatrix = (m: InventoryMatrix): number => {
    let total = 0;
    for (const row of Object.values(m)) {
      for (const c of Object.values(row)) total += c;
    }
    return total;
  };
  const sumType = (type: FullArtifactType): number => {
    const u = inventory.user[type] ?? {};
    const p = inventory.plugin[type] ?? {};
    const sumRow = (r: Record<string, number>) =>
      Object.values(r).reduce((a, b) => a + b, 0);
    return sumRow(u) + sumRow(p);
  };

  const telemetryEntry = {
    timestamp: new Date().toISOString(),
    surface: 'afk',
    scope,
    total_artifacts: allVerdicts.length,
    misfits_count: misfits.length,
    briefs_written: briefsWritten,
    by_source: {
      user: sumMatrix(inventory.user),
      plugin: sumMatrix(inventory.plugin),
    },
    by_type: {
      skill: sumType('skill'),
      command: sumType('command'),
      agent: sumType('agent'),
      hook: sumType('hook'),
    },
  };

  const telemetryPath = join(telemetryDir, 'audit-fit-telemetry.jsonl');
  await appendFile(telemetryPath, JSON.stringify(telemetryEntry) + '\n');

  return {
    inventory,
    misfits,
    briefs_written: briefsWritten,
    total_artifacts: allVerdicts.length,
  };
}

export const auditFitSkill: SkillMetadata = {
  name: 'audit-fit',
  description:
    'Audit ~/.afk artifacts (skills, commands, agents, hooks) for correct type categorization. Walks user-scope dirs (~/.afk/{skills,commands,agents}/) and every plugin installed under ~/.afk/plugins/ (flat and marketplace-cache layouts), plus ~/.afk/settings.json for hooks. Dispatches per-type inspectors in parallel, applies decision heuristics (progressive-disclosure value, isolation need, deterministic vs. reasoning), flags misfits. Generates migration briefs only for user-scope misfits (plugin misfits are inventory-only — refactoring vendored plugin code is the maintainer\'s job). Optional `scope` input filters to `user`, `plugin`, or `all` (default). Use for inventory audits after bulk authoring, imports, or periodic hygiene.',
  handler,
  argumentHint: '[--write-briefs]',
  whenToUse: 'When the user wants ~/.afk artifacts (skills, commands, agents, hooks) audited for correct type categorization.',
  flags: ['--write-briefs'],
  // Maintainer-loop skill: writes briefs to `$AFK_HOME/agent-framework/briefs/`.
  // End users have no use for the brief output, so the skill is hidden unless
  // `AFK_INTERNAL=1` unlocks it.
  audience: 'internal',
};

registerSkill(auditFitSkill);
