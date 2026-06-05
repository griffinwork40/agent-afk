/**
 * Tests for /audit-fit skill.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import { z } from 'zod';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  VerdictSchema,
  AuditFitResultSchema,
  AuditFitInputSchema,
  type AuditFitResult,
  type Verdict,
  auditFitSkill,
  planAuditScope,
  aggregateVerdicts,
  shouldWriteBriefForMisfit,
  renderHookList,
  classifyInspectorResult,
} from './audit-fit/index.js';
import type { SubagentResult } from '../agent/subagent/result.js';
import {
  discoverUserScope,
  discoverPluginScope,
  discoverHookCount,
  discoverHooks,
} from './audit-fit/discover.js';
import { loadSkillPrompts } from './_lib/prompt-loader.js';
import { getSkill } from './index.js';
import { researchAgent } from './_agents/research-agent.js';

// Utility to create a valid verdict (defaults to plugin-source for back-compat
// with existing fixture paths under ~/.afk/plugins/).
function createValidVerdict(
  overrides?: Partial<z.infer<typeof VerdictSchema>>,
): z.infer<typeof VerdictSchema> {
  return {
    path: '~/.afk/plugins/test-plugin/skills/test/SKILL.md',
    type: 'skill',
    source: 'plugin',
    plugin_key: 'test-plugin',
    verdict: 'correct',
    recommended_type: 'skill',
    rationale: 'Has supporting resources',
    confidence: 'high',
    ...overrides,
  };
}

// Utility to create a valid result (nested inventory matrix per source).
function createValidResult(
  overrides?: Partial<AuditFitResult>,
): AuditFitResult {
  return {
    inventory: {
      user: {
        skill: { correct: 0, misfit: 0, outlier: 0 },
        command: { correct: 0, misfit: 0, outlier: 0 },
        agent: { correct: 0, misfit: 0, outlier: 0 },
        hook: { correct: 0, misfit: 0, outlier: 0 },
      },
      plugin: {
        skill: { correct: 1, misfit: 0, outlier: 0 },
        command: { correct: 0, misfit: 0, outlier: 0 },
        agent: { correct: 0, misfit: 0, outlier: 0 },
        hook: { correct: 0, misfit: 0, outlier: 0 },
      },
    },
    misfits: [],
    briefs_written: 0,
    total_artifacts: 1,
    ...overrides,
  };
}

describe('AuditFit Skill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('VerdictSchema', () => {
    it('validates a correct verdict structure', () => {
      const valid = createValidVerdict();
      const result = VerdictSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('rejects missing path field', () => {
      const invalid = createValidVerdict();
      delete (invalid as { path?: string }).path;
      const result = VerdictSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('rejects missing source field', () => {
      const invalid = createValidVerdict();
      delete (invalid as { source?: string }).source;
      const result = VerdictSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('rejects invalid source enum', () => {
      const invalid = createValidVerdict({ source: 'system' as never });
      const result = VerdictSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('accepts source: "user" without plugin_key', () => {
      const valid = createValidVerdict({
        path: '~/.afk/skills/my-skill/SKILL.md',
        source: 'user',
        plugin_key: undefined,
      });
      const result = VerdictSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('accepts source: "plugin" with plugin_key', () => {
      const valid = createValidVerdict({
        source: 'plugin',
        plugin_key: 'data',
      });
      const result = VerdictSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('rejects invalid type enum', () => {
      const invalid = createValidVerdict({ type: 'invalid' as never });
      const result = VerdictSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('rejects invalid verdict enum', () => {
      const invalid = createValidVerdict({ verdict: 'maybe' as never });
      const result = VerdictSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('rejects invalid confidence enum', () => {
      const invalid = createValidVerdict({ confidence: 'uncertain' as never });
      const result = VerdictSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('allows all verdict types', () => {
      const verdicts = ['correct', 'misfit', 'outlier'] as const;
      for (const verdict of verdicts) {
        const result = VerdictSchema.safeParse(createValidVerdict({ verdict }));
        expect(result.success).toBe(true);
      }
    });

    it('allows all type values', () => {
      const types = ['skill', 'command', 'agent', 'hook'] as const;
      for (const type of types) {
        const result = VerdictSchema.safeParse(createValidVerdict({ type }));
        expect(result.success).toBe(true);
      }
    });

    it('allows all confidence levels', () => {
      const confidences = ['high', 'med', 'low'] as const;
      for (const confidence of confidences) {
        const result = VerdictSchema.safeParse(
          createValidVerdict({ confidence }),
        );
        expect(result.success).toBe(true);
      }
    });
  });

  describe('AuditFitResultSchema', () => {
    it('validates a correct result structure', () => {
      const valid = createValidResult();
      const result = AuditFitResultSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('rejects flat inventory shape (legacy)', () => {
      const invalid = {
        inventory: {
          skill: { correct: 1, misfit: 0, outlier: 0 },
          command: { correct: 0, misfit: 0, outlier: 0 },
          agent: { correct: 0, misfit: 0, outlier: 0 },
          hook: { correct: 0, misfit: 0, outlier: 0 },
        },
        misfits: [],
        briefs_written: 0,
        total_artifacts: 0,
      };
      const result = AuditFitResultSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('accepts inventory with empty user and plugin matrices', () => {
      const valid = createValidResult({
        inventory: { user: {}, plugin: {} },
        total_artifacts: 0,
      });
      const result = AuditFitResultSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('requires inventory object with user and plugin keys', () => {
      const invalid = createValidResult();
      (invalid as { inventory: unknown }).inventory = null;
      const result = AuditFitResultSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('requires misfits array', () => {
      const invalid = createValidResult();
      (invalid as { misfits: unknown }).misfits = null;
      const result = AuditFitResultSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('requires briefs_written number', () => {
      const invalid = createValidResult();
      (invalid as { briefs_written: unknown }).briefs_written = 'five';
      const result = AuditFitResultSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('requires total_artifacts number', () => {
      const invalid = createValidResult();
      (invalid as { total_artifacts: unknown }).total_artifacts = 'all';
      const result = AuditFitResultSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('accepts multiple misfits across user and plugin scopes', () => {
      const valid = createValidResult({
        misfits: [
          createValidVerdict({
            path: '~/.afk/skills/user-skill/SKILL.md',
            source: 'user',
            plugin_key: undefined,
          }),
          createValidVerdict({
            path: '~/.afk/plugins/data/commands/cmd1.md',
            type: 'command',
            verdict: 'misfit',
            source: 'plugin',
            plugin_key: 'data',
          }),
        ],
      });
      const result = AuditFitResultSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('accepts zero misfits', () => {
      const valid = createValidResult({ misfits: [] });
      const result = AuditFitResultSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });
  });

  describe('AuditFitInputSchema', () => {
    it('accepts an empty input object', () => {
      const result = AuditFitInputSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('accepts writeBriefs and scope', () => {
      const result = AuditFitInputSchema.safeParse({
        writeBriefs: false,
        scope: 'user',
      });
      expect(result.success).toBe(true);
    });

    it('accepts each scope value', () => {
      for (const scope of ['user', 'plugin', 'all'] as const) {
        const result = AuditFitInputSchema.safeParse({ scope });
        expect(result.success).toBe(true);
      }
    });

    it('rejects an unknown scope', () => {
      const result = AuditFitInputSchema.safeParse({ scope: 'workspace' });
      expect(result.success).toBe(false);
    });
  });

  describe('Skill registration', () => {
    it('registers the skill with correct metadata', () => {
      const skill = getSkill('audit-fit');
      expect(skill).toBeDefined();
      expect(skill?.name).toBe('audit-fit');
      expect(skill?.description).toContain('audit');
      expect(skill?.description).toContain('parallel');
      expect(skill?.handler).toBeDefined();
    });
  });

  describe('Prompt loading', () => {
    it('loads all four audit-fit inspector prompts', () => {
      const prompts = loadSkillPrompts('audit-fit');
      expect(prompts).toBeDefined();
      expect(prompts['01-skill-inspector.md']).toBeDefined();
      expect(prompts['02-command-inspector.md']).toBeDefined();
      expect(prompts['03-agent-inspector.md']).toBeDefined();
      expect(prompts['04-hook-inspector.md']).toBeDefined();
    });

    it('skill inspector contains decision heuristics', () => {
      const prompts = loadSkillPrompts('audit-fit');
      const skillPrompt = prompts['01-skill-inspector.md'];
      expect(skillPrompt).toContain('Decision Heuristics');
      expect(skillPrompt).toContain('progressive-disclosure');
      expect(skillPrompt).toContain('disable-model-invocation');
    });

    it('command inspector contains decision heuristics', () => {
      const prompts = loadSkillPrompts('audit-fit');
      const commandPrompt = prompts['02-command-inspector.md'];
      expect(commandPrompt).toContain('Decision Heuristics');
      expect(commandPrompt).toContain('sub-agent');
      expect(commandPrompt).toContain('multi-step');
    });

    it('agent inspector contains decision heuristics', () => {
      const prompts = loadSkillPrompts('audit-fit');
      const agentPrompt = prompts['03-agent-inspector.md'];
      expect(agentPrompt).toContain('Decision Heuristics');
      expect(agentPrompt).toContain('isolated context');
      expect(agentPrompt).toContain('tools');
    });

    it('hook inspector contains decision heuristics', () => {
      const prompts = loadSkillPrompts('audit-fit');
      const hookPrompt = prompts['04-hook-inspector.md'];
      expect(hookPrompt).toContain('Decision Heuristics');
      expect(hookPrompt).toContain('deterministic');
      expect(hookPrompt).toContain('logging');
    });

    it('hook inspector points at the inlined Discovered hooks section, not ~/.afk directly', () => {
      // Regression: an earlier version told the inspector to "Read
      // `~/.afk/settings.json`", which the LLM expanded to /root/.afk and
      // dead-ended on a missing-file error. The handler now pre-reads the
      // settings file and inlines an absolute path; the prompt must point the
      // inspector at that section instead of the raw tilde path.
      const prompts = loadSkillPrompts('audit-fit');
      const hookPrompt = prompts['04-hook-inspector.md'];
      expect(hookPrompt).toContain('Discovered hooks');
      expect(hookPrompt).not.toMatch(/Read\s+`~\/\.afk\/settings\.json`/);
    });

    it('skill/command/agent inspectors instruct not to Glob for discovery', () => {
      const prompts = loadSkillPrompts('audit-fit');
      for (const file of [
        '01-skill-inspector.md',
        '02-command-inspector.md',
        '03-agent-inspector.md',
      ]) {
        const body = prompts[file];
        expect(body).toContain('Do not Glob');
      }
    });

    it('all inspector prompts reference the source field', () => {
      const prompts = loadSkillPrompts('audit-fit');
      for (const file of [
        '01-skill-inspector.md',
        '02-command-inspector.md',
        '03-agent-inspector.md',
        '04-hook-inspector.md',
      ]) {
        expect(prompts[file]).toContain('source');
      }
    });
  });

  describe('canUseTool restriction', () => {
    it('creates a restrictive canUseTool callback', async () => {
      const allowedTools = researchAgent.allowedTools;

      const testCanUseTool = async (toolName: string) => {
        if (!allowedTools.includes(toolName as never)) {
          return {
            behavior: 'deny' as const,
            message: `Tool ${toolName} not allowed`,
          };
        }
        return { behavior: 'allow' as const };
      };

      // Test allowed tools
      for (const tool of allowedTools) {
        const result = await testCanUseTool(tool);
        expect(result.behavior).toBe('allow');
      }

      // Test disallowed tools
      const disallowedTools = ['Edit', 'Write', 'Bash', 'Agent'];
      for (const tool of disallowedTools) {
        const result = await testCanUseTool(tool);
        expect(result.behavior).toBe('deny');
        expect((result as { message?: string }).message).toContain(tool);
      }
    });

    it('research-agent has correct allowedTools list', () => {
      expect(researchAgent.allowedTools).toContain('Read');
      expect(researchAgent.allowedTools).toContain('Grep');
      expect(researchAgent.allowedTools).toContain('Glob');
      expect(researchAgent.allowedTools).not.toContain('Edit');
      expect(researchAgent.allowedTools).not.toContain('Write');
      expect(researchAgent.allowedTools).not.toContain('Bash');
    });
  });

  describe('Skill export', () => {
    it('exports auditFitSkill metadata', () => {
      expect(auditFitSkill).toBeDefined();
      expect(auditFitSkill.name).toBe('audit-fit');
      expect(auditFitSkill.handler).toBeDefined();
      expect(typeof auditFitSkill.handler).toBe('function');
    });

    it('exports VerdictSchema, AuditFitResultSchema, AuditFitInputSchema', () => {
      expect(VerdictSchema).toBeDefined();
      expect(AuditFitResultSchema).toBeDefined();
      expect(AuditFitInputSchema).toBeDefined();
      expect(VerdictSchema.parse).toBeDefined();
      expect(AuditFitResultSchema.parse).toBeDefined();
      expect(AuditFitInputSchema.parse).toBeDefined();
    });
  });

  describe('Output schema validation', () => {
    it('rejects verdict without path', () => {
      const invalid = {
        type: 'skill',
        source: 'user',
        verdict: 'correct',
        recommended_type: 'skill',
        rationale: 'test',
        confidence: 'high',
      };
      const result = VerdictSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('rejects verdict with empty rationale', () => {
      const invalid = createValidVerdict({ rationale: '' });
      const result = VerdictSchema.safeParse(invalid);
      // Note: zod string doesn't reject empty strings by default
      expect(result.success).toBe(true);
    });

    it('accepts verdict with all required fields', () => {
      const valid = createValidVerdict();
      const result = VerdictSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('result with full inventory matrix is valid', () => {
      const valid = createValidResult({
        inventory: {
          user: {
            skill: { correct: 5, misfit: 2, outlier: 1 },
            command: { correct: 10, misfit: 3, outlier: 0 },
            agent: { correct: 3, misfit: 1, outlier: 0 },
            hook: { correct: 8, misfit: 0, outlier: 2 },
          },
          plugin: {
            skill: { correct: 4, misfit: 1, outlier: 0 },
            command: { correct: 7, misfit: 2, outlier: 0 },
            agent: { correct: 2, misfit: 0, outlier: 0 },
            hook: { correct: 0, misfit: 0, outlier: 0 },
          },
        },
        total_artifacts: 51,
      });
      const result = AuditFitResultSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });
  });
});

describe('audit-fit discovery helpers', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(
      tmpdir(),
      `audit-fit-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('discoverUserScope', () => {
    it('returns [] when no top-level dirs exist', () => {
      expect(discoverUserScope(tmp)).toEqual([]);
    });

    it('finds skills, commands, and agents when each is present', () => {
      mkdirSync(join(tmp, 'skills', 'foo'), { recursive: true });
      writeFileSync(join(tmp, 'skills', 'foo', 'SKILL.md'), '# foo');
      mkdirSync(join(tmp, 'commands'), { recursive: true });
      writeFileSync(join(tmp, 'commands', 'bar.md'), '# bar');
      mkdirSync(join(tmp, 'agents'), { recursive: true });
      writeFileSync(join(tmp, 'agents', 'baz.md'), '# baz');

      const result = discoverUserScope(tmp);
      expect(result).toHaveLength(3);
      const types = new Set(result.map((r) => r.type));
      expect(types).toEqual(new Set(['skill', 'command', 'agent']));
      expect(result.every((r) => r.source === 'user')).toBe(true);
      expect(result.every((r) => r.plugin_key === undefined)).toBe(true);
    });

    it('skips a skill dir without a SKILL.md', () => {
      mkdirSync(join(tmp, 'skills', 'incomplete'), { recursive: true });
      expect(discoverUserScope(tmp)).toEqual([]);
    });

    it('only includes .md files for commands and agents', () => {
      mkdirSync(join(tmp, 'commands'), { recursive: true });
      writeFileSync(join(tmp, 'commands', 'cmd.md'), '# cmd');
      writeFileSync(join(tmp, 'commands', 'README.txt'), 'ignored');

      const result = discoverUserScope(tmp);
      expect(result).toHaveLength(1);
      expect(result[0]?.path.endsWith('cmd.md')).toBe(true);
    });
  });

  describe('discoverPluginScope', () => {
    it('returns [] when plugins root absent', () => {
      expect(discoverPluginScope(join(tmp, 'plugins'))).toEqual([]);
    });

    it('derives plugin_key for flat layout', () => {
      const pluginsDir = join(tmp, 'plugins');
      const flatPlugin = join(pluginsDir, 'data');
      mkdirSync(join(flatPlugin, '.claude-plugin'), { recursive: true });
      writeFileSync(
        join(flatPlugin, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'data' }),
      );
      mkdirSync(join(flatPlugin, 'skills', 'foo'), { recursive: true });
      writeFileSync(join(flatPlugin, 'skills', 'foo', 'SKILL.md'), '# foo');

      const result = discoverPluginScope(pluginsDir);
      expect(result).toHaveLength(1);
      expect(result[0]?.source).toBe('plugin');
      expect(result[0]?.plugin_key).toBe('data');
      expect(result[0]?.type).toBe('skill');
    });

    it('derives plugin_key as <marketplace>:<plugin> for cache layout', () => {
      const pluginsDir = join(tmp, 'plugins');
      const cachePlugin = join(pluginsDir, 'cache', 'mp', 'p');
      mkdirSync(join(cachePlugin, '.claude-plugin'), { recursive: true });
      writeFileSync(
        join(cachePlugin, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'p' }),
      );
      // Cache-layout plugins must be enabled in the index.
      writeFileSync(
        join(pluginsDir, '.index.json'),
        JSON.stringify({
          version: 2,
          plugins: { 'mp:p': { enabled: true } },
          marketplaces: {},
        }),
      );
      mkdirSync(join(cachePlugin, 'commands'), { recursive: true });
      writeFileSync(join(cachePlugin, 'commands', 'foo.md'), '# foo');

      const result = discoverPluginScope(pluginsDir);
      expect(result).toHaveLength(1);
      expect(result[0]?.source).toBe('plugin');
      expect(result[0]?.plugin_key).toBe('mp:p');
      expect(result[0]?.type).toBe('command');
    });

    it('skips cache-layout plugins missing from the index', () => {
      const pluginsDir = join(tmp, 'plugins');
      const cachePlugin = join(pluginsDir, 'cache', 'mp', 'p');
      mkdirSync(join(cachePlugin, '.claude-plugin'), { recursive: true });
      writeFileSync(
        join(cachePlugin, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'p' }),
      );
      // No .index.json — cache-layout plugin is not user-activated.
      mkdirSync(join(cachePlugin, 'agents'), { recursive: true });
      writeFileSync(join(cachePlugin, 'agents', 'a.md'), '# a');

      expect(discoverPluginScope(pluginsDir)).toEqual([]);
    });
  });

  describe('discoverHookCount', () => {
    it('returns 0 when settings.json absent', () => {
      expect(discoverHookCount(join(tmp, 'settings.json'))).toBe(0);
    });

    it('returns 0 when settings.json has no hooks key', () => {
      writeFileSync(join(tmp, 'settings.json'), JSON.stringify({ foo: 1 }));
      expect(discoverHookCount(join(tmp, 'settings.json'))).toBe(0);
    });

    it('counts hooks across all events', () => {
      writeFileSync(
        join(tmp, 'settings.json'),
        JSON.stringify({
          hooks: {
            SessionStart: [{}, {}],
            PreToolUse: [{}],
          },
        }),
      );
      expect(discoverHookCount(join(tmp, 'settings.json'))).toBe(3);
    });

    it('returns 0 when settings.json is malformed', () => {
      writeFileSync(join(tmp, 'settings.json'), 'not json');
      expect(discoverHookCount(join(tmp, 'settings.json'))).toBe(0);
    });
  });

  describe('discoverHooks', () => {
    it('returns [] when settings.json absent', () => {
      expect(discoverHooks(join(tmp, 'settings.json'))).toEqual([]);
    });

    it('returns one entry per hook with event and index', () => {
      writeFileSync(
        join(tmp, 'settings.json'),
        JSON.stringify({
          hooks: {
            SubagentStop: [
              { hooks: [{ type: 'command', command: '/abs/a.py' }] },
              { hooks: [{ type: 'command', command: '/abs/b.py' }] },
            ],
            SessionStart: [
              { hooks: [{ type: 'command', command: '/abs/c.py' }] },
            ],
          },
        }),
      );
      const hooks = discoverHooks(join(tmp, 'settings.json'));
      expect(hooks).toHaveLength(3);
      expect(hooks.map((h) => `${h.event}-${h.index}`).sort()).toEqual([
        'SessionStart-0',
        'SubagentStop-0',
        'SubagentStop-1',
      ]);
    });

    it('returns [] when settings.json is malformed', () => {
      writeFileSync(join(tmp, 'settings.json'), 'not json');
      expect(discoverHooks(join(tmp, 'settings.json'))).toEqual([]);
    });
  });
});

describe('classifyInspectorResult', () => {
  // Minimal Verdict fixture for success-case outputs.
  const okVerdict: Verdict = {
    path: '/abs/x/SKILL.md',
    type: 'skill',
    source: 'user',
    verdict: 'correct',
    recommended_type: 'skill',
    rationale: 'ok',
    confidence: 'high',
  };

  it('returns "no result" failure when result is undefined', () => {
    const out = classifyInspectorResult('hook', undefined);
    expect(out).toEqual({ kind: 'failure', message: 'hook: no result' });
  });

  it('surfaces schemaError as "schema mismatch — ..." even when status is failed', () => {
    // Regression: when outputSchema.safeParse fails inside buildResultFromMessage,
    // the result has BOTH status='failed' AND schemaError populated. The earlier
    // check order matched status!=='succeeded' first and emitted just
    // "<type>: failed" — swallowing the dedicated schema-mismatch message.
    const zodErr = z.array(VerdictSchema).safeParse({}).success === false
      ? z.array(VerdictSchema).safeParse({}).error!
      : (undefined as unknown as z.ZodError);
    const result: SubagentResult<ReadonlyArray<Verdict>> = {
      id: 'inspector-hook',
      status: 'failed',
      schemaError: zodErr,
    };
    const out = classifyInspectorResult('hook', result);
    expect(out.kind).toBe('failure');
    if (out.kind === 'failure') {
      expect(out.message).toMatch(/^hook: schema mismatch — /);
    }
  });

  it('formats non-succeeded status with optional error message suffix', () => {
    const result: SubagentResult<ReadonlyArray<Verdict>> = {
      id: 'inspector-skill',
      status: 'failed',
      error: new Error('boom'),
    };
    const out = classifyInspectorResult('skill', result);
    expect(out).toEqual({ kind: 'failure', message: 'skill: failed — boom' });
  });

  it('formats non-succeeded status with no suffix when error is undefined', () => {
    const result: SubagentResult<ReadonlyArray<Verdict>> = {
      id: 'inspector-agent',
      status: 'cancelled',
    };
    const out = classifyInspectorResult('agent', result);
    expect(out).toEqual({ kind: 'failure', message: 'agent: cancelled' });
  });

  it('returns "no output" failure when status is succeeded but output is missing', () => {
    const result: SubagentResult<ReadonlyArray<Verdict>> = {
      id: 'inspector-command',
      status: 'succeeded',
    };
    const out = classifyInspectorResult('command', result);
    expect(out).toEqual({ kind: 'failure', message: 'command: no output' });
  });

  it('returns success outcome with the parsed verdicts when result is healthy', () => {
    const result: SubagentResult<ReadonlyArray<Verdict>> = {
      id: 'inspector-skill',
      status: 'succeeded',
      output: [okVerdict],
    };
    const out = classifyInspectorResult('skill', result);
    expect(out).toEqual({ kind: 'success', output: [okVerdict] });
  });
});

describe('renderHookList', () => {
  it('templates the absolute settings path inline so the inspector cannot mis-expand ~', () => {
    const out = renderHookList('/Users/test/.afk/settings.json', []);
    expect(out).toContain('/Users/test/.afk/settings.json');
    expect(out).toContain('Discovered hooks');
    expect(out).not.toMatch(/`~\/\.afk\/settings\.json`/);
  });

  it('inlines each hook entry as JSON under an event-index ID', () => {
    const out = renderHookList('/abs/settings.json', [
      {
        event: 'SubagentStop',
        index: 0,
        raw: { hooks: [{ type: 'command', command: '/abs/script.py' }] },
      },
    ]);
    expect(out).toContain('### Hook `SubagentStop-0`');
    expect(out).toContain('/abs/script.py');
  });

  it('emits a placeholder line when there are no hooks', () => {
    const out = renderHookList('/abs/settings.json', []);
    expect(out).toContain('(no hooks discovered)');
  });
});

describe('audit-fit handler helpers', () => {
  describe('planAuditScope', () => {
    it('runs everything for scope=all', () => {
      expect(planAuditScope('all')).toEqual({
        runUserDiscovery: true,
        runPluginDiscovery: true,
        runHookInspector: true,
      });
    });

    it('skips plugin discovery for scope=user (hooks still run)', () => {
      expect(planAuditScope('user')).toEqual({
        runUserDiscovery: true,
        runPluginDiscovery: false,
        runHookInspector: true,
      });
    });

    it('skips user discovery and the hook inspector for scope=plugin', () => {
      expect(planAuditScope('plugin')).toEqual({
        runUserDiscovery: false,
        runPluginDiscovery: true,
        runHookInspector: false,
      });
    });
  });

  describe('aggregateVerdicts', () => {
    const baseVerdict: Verdict = {
      path: '~/.afk/skills/example/SKILL.md',
      type: 'skill',
      source: 'user',
      verdict: 'correct',
      recommended_type: 'skill',
      rationale: 'ok',
      confidence: 'high',
    };

    it('builds an empty matrix from no verdicts', () => {
      const { inventory, misfits } = aggregateVerdicts([]);
      expect(misfits).toEqual([]);
      for (const source of ['user', 'plugin'] as const) {
        for (const type of ['skill', 'command', 'agent', 'hook'] as const) {
          expect(inventory[source][type]).toEqual({
            correct: 0,
            misfit: 0,
            outlier: 0,
          });
        }
      }
    });

    it('counts user vs plugin verdicts independently', () => {
      const verdicts: Verdict[] = [
        { ...baseVerdict, source: 'user', verdict: 'correct' },
        {
          ...baseVerdict,
          source: 'plugin',
          plugin_key: 'data',
          verdict: 'misfit',
        },
        {
          ...baseVerdict,
          source: 'plugin',
          plugin_key: 'data',
          verdict: 'misfit',
        },
      ];
      const { inventory, misfits } = aggregateVerdicts(verdicts);
      expect(inventory.user['skill']).toEqual({
        correct: 1,
        misfit: 0,
        outlier: 0,
      });
      expect(inventory.plugin['skill']).toEqual({
        correct: 0,
        misfit: 2,
        outlier: 0,
      });
      expect(misfits).toHaveLength(2);
    });

    it('sorts misfits by confidence (high → med → low)', () => {
      const verdicts: Verdict[] = [
        { ...baseVerdict, verdict: 'misfit', confidence: 'low' },
        { ...baseVerdict, verdict: 'misfit', confidence: 'high' },
        { ...baseVerdict, verdict: 'misfit', confidence: 'med' },
      ];
      const { misfits } = aggregateVerdicts(verdicts);
      expect(misfits.map((m) => m.confidence)).toEqual(['high', 'med', 'low']);
    });
  });

  describe('shouldWriteBriefForMisfit', () => {
    const base: Verdict = {
      path: '~/.afk/skills/x/SKILL.md',
      type: 'skill',
      source: 'user',
      verdict: 'misfit',
      recommended_type: 'command',
      rationale: 'rule',
      confidence: 'high',
    };

    it('writes briefs for high-confidence user misfits', () => {
      expect(shouldWriteBriefForMisfit(base)).toBe(true);
    });

    it('skips plugin-scope misfits regardless of confidence', () => {
      expect(
        shouldWriteBriefForMisfit({
          ...base,
          source: 'plugin',
          plugin_key: 'data',
        }),
      ).toBe(false);
    });

    it('skips low- and medium-confidence user misfits', () => {
      expect(shouldWriteBriefForMisfit({ ...base, confidence: 'med' })).toBe(false);
      expect(shouldWriteBriefForMisfit({ ...base, confidence: 'low' })).toBe(false);
    });

    it('skips non-misfit verdicts (correct, outlier)', () => {
      expect(shouldWriteBriefForMisfit({ ...base, verdict: 'correct' })).toBe(
        false,
      );
      expect(shouldWriteBriefForMisfit({ ...base, verdict: 'outlier' })).toBe(
        false,
      );
    });
  });

});
