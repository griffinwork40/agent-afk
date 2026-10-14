/**
 * audit-fit handler -- orchestrates discovery, inspector subagents, verdict
 * aggregation, brief writing, and telemetry for /audit-fit.
 *
 * @module skills/audit-fit/handler
 */

import { z } from 'zod';
import { mkdir, appendFile } from 'fs/promises';
import { join } from 'path';
import { loadSkillPrompts } from '../_lib/prompt-loader.js';
import type { SkillExecutionContext } from '../index.js';
import { resolveChildModel } from '../../agent/subagent/resolve-child-model.js';
import { SubagentManager } from '../../agent/subagent.js';
import { runWave } from '../../agent/subagent/wave.js';
import type { IAgentSession } from '../../agent/types.js';
import type { CanUseTool } from '../../agent/types/sdk-types.js';
import { researchAgent } from '../_agents/research-agent.js';
import { vendoredToolAllowlist } from '../_agents/to-definition.js';
import { getAfkHome, getAgentFrameworkDir, getBriefsDir } from '../../paths.js';
import {
  discoverUserScope,
  discoverPluginScope,
  discoverHooks,
  type DiscoveredArtifact,
  type ArtifactType,
} from './discover.js';
import {
  VerdictSchema,
  AuditFitInputSchema,
  planAuditScope,
  aggregateVerdicts,
  shouldWriteBriefForMisfit,
  classifyInspectorResult,
  renderHookList,
  type Verdict,
  type AuditFitResult,
  type InventoryMatrix,
  type Scope,
  type FullArtifactType,
  ALL_TYPES,
} from './schemas.js';

type Source = 'user' | 'plugin';

const FILE_TYPES: ReadonlyArray<ArtifactType> = ['skill', 'command', 'agent'];

interface InspectorConfig {
  type: FullArtifactType;
  prompt: string;
  artifacts: ReadonlyArray<DiscoveredArtifact>;
  runPrompt: string;
}

function renderArtifactList(artifacts: ReadonlyArray<DiscoveredArtifact>): string {
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
  out.push('### Plugin-scope artifacts (set `"source": "plugin"`, copy `plugin_key` from each entry)');
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

async function runInspectors(
  configs: InspectorConfig[],
  manager: SubagentManager,
  subagentModel: string,
  sessionId: string,
  skillCallId: string | undefined,
  inspectorTools: Set<string>,
): Promise<Verdict[]> {
  if (configs.length === 0) return [];

  const createCanUseTool = (): CanUseTool => async (toolName: string) => {
    if (!inspectorTools.has(toolName)) {
      return {
        behavior: 'deny',
        message: `Tool ${toolName} not allowed for audit-fit inspectors. Allowed tools: ${[...inspectorTools].join(', ')}`,
      };
    }
    return { behavior: 'allow' };
  };

  const handles = await Promise.all(
    configs.map((cfg) =>
      manager.forkSubagent({
        parent: { sessionId },
        config: {
          model: subagentModel,
          systemPrompt: `${researchAgent.systemPrompt}\n\n${cfg.prompt}`,
          canUseTool: createCanUseTool(),
        },
        idPrefix: `inspector-${cfg.type}`,
        agentType: `inspector-${cfg.type}`,
        outputSchema: z.array(VerdictSchema),
        ...(skillCallId ? { parentId: skillCallId } : {}),
      }),
    ),
  );

  const results = await runWave(
    configs.map((cfg, i) => {
      const handle = handles[i];
      if (!handle) throw new Error(`audit-fit: missing handle for ${cfg.type} inspector`);
      return { handle, prompt: cfg.runPrompt };
    }),
    { failFast: false },
  );

  const allVerdicts: Verdict[] = [];
  const failures: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const cfg = configs[i];
    if (!cfg) continue;
    const outcome = classifyInspectorResult(cfg.type, result);
    if (outcome.kind === 'failure') { failures.push(outcome.message); continue; }

    // Defensive: verdicts the inspector returns must match the source we sent in
    // (catches an inspector that fabricates a verdict for an undiscovered path, or
    // flips its source annotation).
    const expectedSource = new Map<string, Source>();
    for (const a of cfg.artifacts) expectedSource.set(a.path, a.source);

    for (const v of outcome.output) {
      if (cfg.type === 'hook') {
        if (v.source !== 'user') {
          failures.push(`${cfg.type}: hook verdict has source=${v.source} (must be 'user')`);
          continue;
        }
      } else {
        const expected = expectedSource.get(v.path);
        if (expected === undefined) {
          failures.push(`${cfg.type}: verdict for unknown path ${v.path} (not in discovered list)`);
          continue;
        }
        if (v.source !== expected) {
          failures.push(`${cfg.type}: verdict source mismatch for ${v.path} (expected ${expected}, got ${v.source})`);
          continue;
        }
      }
      allVerdicts.push(v);
    }
  }

  if (failures.length > 0) {
    throw new Error(`audit-fit: ${failures.length} inspector failure(s):\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  }
  return allVerdicts;
}

async function writeBriefsForMisfits(misfits: ReadonlyArray<Verdict>, briefsDir: string): Promise<number> {
  await mkdir(briefsDir, { recursive: true });
  let count = 0;
  for (const misfit of misfits.filter(shouldWriteBriefForMisfit)) {
    const slug = misfit.path.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 30);
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
    count++;
  }
  return count;
}

function buildTelemetryEntry(
  inventory: AuditFitResult['inventory'],
  allVerdicts: ReadonlyArray<Verdict>,
  misfits: ReadonlyArray<Verdict>,
  briefsWritten: number,
  scope: Scope,
): object {
  const sumMatrix = (m: InventoryMatrix): number => {
    let total = 0;
    for (const row of Object.values(m)) for (const c of Object.values(row)) total += c;
    return total;
  };
  const sumType = (type: FullArtifactType): number => {
    const u = inventory.user[type] ?? {};
    const p = inventory.plugin[type] ?? {};
    const sumRow = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
    return sumRow(u) + sumRow(p);
  };
  return {
    timestamp: new Date().toISOString(),
    surface: 'afk',
    scope,
    total_artifacts: allVerdicts.length,
    misfits_count: misfits.length,
    briefs_written: briefsWritten,
    by_source: { user: sumMatrix(inventory.user), plugin: sumMatrix(inventory.plugin) },
    by_type: {
      skill: sumType('skill'),
      command: sumType('command'),
      agent: sumType('agent'),
      hook: sumType('hook'),
    },
  };
}

/**
 * Handler for the /audit-fit skill.
 *
 * Contract: no AFK_INTERNAL handler guard here -- intentional. /audit-fit
 * audits the caller's own ~/.afk artifacts and writes briefs locally, so it
 * runs fine for anyone. Its `audience: 'internal'` tag hides it from
 * end-user surfaces for UX (end users have no use for the brief output),
 * not because dispatch would break.
 */
export async function handler(
  input: unknown,
  parentSession?: IAgentSession,
  ctx?: SkillExecutionContext,
): Promise<AuditFitResult> {
  const apiKey = ctx?.apiKey;
  const subagentModel = resolveChildModel({
    defaultSubagentModel: ctx?.defaultSubagentModel,
    defaultModel: ctx?.defaultModel,
  });
  const skillCallId = ctx?.callId;
  const inputObj = typeof input === 'object' && input !== null ? input : {};
  const parsed = AuditFitInputSchema.parse(inputObj);
  const writeBriefs = parsed.writeBriefs ?? true;
  const scope: Scope = parsed.scope ?? 'all';
  const plan = planAuditScope(scope);

  if (!parentSession?.sessionId) throw new Error('audit-fit requires a parent session with sessionId');
  const sessionId = parentSession.sessionId;

  const prompts = loadSkillPrompts('audit-fit');
  const promptByType: Record<FullArtifactType, string | undefined> = {
    skill: prompts['01-skill-inspector.md'],
    command: prompts['02-command-inspector.md'],
    agent: prompts['03-agent-inspector.md'],
    hook: prompts['04-hook-inspector.md'],
  };
  for (const t of ALL_TYPES) {
    if (!promptByType[t]) throw new Error(`audit-fit skill missing inspector prompt for ${t}`);
  }

  const userArtifacts = plan.runUserDiscovery ? discoverUserScope() : [];
  const pluginArtifacts = plan.runPluginDiscovery ? discoverPluginScope() : [];

  const byType: Record<ArtifactType, DiscoveredArtifact[]> = { skill: [], command: [], agent: [] };
  for (const a of [...userArtifacts, ...pluginArtifacts]) byType[a.type].push(a);

  // Forward the parent's witness writer AND workspace store (when ctx supplies them).
  // Read-scope note (#547): NO cwd/parentReadRoots on purpose -- inspectors roam
  // ~/.afk artifacts OUTSIDE any repo, so a cwd-less (read-open) manager is required.
  // #2844: parentCredential pairs key + source model atomically when both are available.
  const credentialOpt =
    apiKey !== undefined && ctx?.defaultModel !== undefined
      ? { parentCredential: { key: apiKey, sourceModel: ctx.defaultModel as string } }
      : apiKey !== undefined ? { apiKey } : {};
  const manager = new SubagentManager({
    ...credentialOpt,
    ...(ctx?.traceWriter !== undefined ? { traceWriter: ctx.traceWriter } : {}),
    ...(ctx?.workspaceStore !== undefined ? { workspaceStore: ctx.workspaceStore } : {}),
    ...(ctx?.delegationBudget !== undefined ? { delegationBudget: ctx.delegationBudget } : {}),
  });

  // Invariant: the gate receives AFK snake_case runtime tool names (read_file, grep, ...),
  // but researchAgent.allowedTools is upstream PascalCase (Read, Grep, ...). Compare
  // against normalized AFK names or every read call is denied.
  // See _agents/to-definition.ts:vendoredToolAllowlist.
  const inspectorTools = vendoredToolAllowlist(researchAgent.allowedTools);

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

  const allVerdicts = await runInspectors(
    inspectorConfigs, manager, subagentModel, sessionId, skillCallId, inspectorTools,
  );

  const { inventory, misfits } = aggregateVerdicts(allVerdicts);
  const briefsWritten = writeBriefs ? await writeBriefsForMisfits(misfits, getBriefsDir()) : 0;

  const telemetryDir = getAgentFrameworkDir();
  await mkdir(telemetryDir, { recursive: true });
  const telemetryEntry = buildTelemetryEntry(inventory, allVerdicts, misfits, briefsWritten, scope);
  await appendFile(join(telemetryDir, 'audit-fit-telemetry.jsonl'), JSON.stringify(telemetryEntry) + '\n');

  return { inventory, misfits, briefs_written: briefsWritten, total_artifacts: allVerdicts.length };
}
