/**
 * Proof that inline skill handlers forking through their own SubagentManager
 * start the child in the SESSION directory, not process.cwd(), and that the
 * gate ChildToolOrigin.cwd carries that same directory.
 *
 * Tests the user-skills.ts (context: fork disk skill) path, which is the
 * primary fix site (H5). Also verifies that the SkillExecutor's inline handler
 * path forwards sessionCwd to the SkillExecutionContext AND that the gate
 * origin carries it via inlineChildGateOpt.
 *
 * Pattern follows nesting.can-use-tool.holes.test.ts: real builders, real
 * providers, real dispatchers; SubagentManager replaced by a recorder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { CanUseTool } from '../types.js';
import type { ChildToolOrigin } from './nesting.can-use-tool.js';
import { inlineSkillChildGate, inlineChildGateOpt } from './nesting.can-use-tool.js';
import { createChildProviderFactory } from './nesting.js';
import { SkillExecutor } from './skill-executor.js';
import { registerSkill, _resetRegistry, type SkillExecutionContext } from '../../skills/skill-registry.js';
import { scanSkillsFromDir } from '../../skills/user-skills.js';
import { resetUsageLedgerForTests } from '../usage/usage-ledger.js';

// Contract: SubagentManager is replaced by a recorder that captures the
// manager's cwd option and the fork config, then refuses to run a model.
const forks = vi.hoisted(() => ({
  calls: [] as Array<{ managerCwd: string | undefined; configCwd: string | undefined }>,
}));

vi.mock('../subagent.js', () => ({
  SUBAGENT_BACKGROUND_TIMEOUT_MS: 60_000,
  SubagentManager: vi.fn(function (this: { _cwd: string | undefined }, opts: { cwd?: string }) {
    this._cwd = opts?.cwd;
    return {
      _cwd: opts?.cwd,
      billingStreamRegistry: new Set(),
      forkSubagent: vi.fn(async function (this: void, o: { config?: { cwd?: string } }) {
        // Capture both the manager-level cwd and any config-level cwd override.
        forks.calls.push({
          managerCwd: opts?.cwd,
          configCwd: (o?.config as { cwd?: string } | undefined)?.cwd,
        });
        throw new Error('recorder: fork captured');
      }),
      setCwd: vi.fn(),
      setTraceWriter: vi.fn(),
      teardownAll: vi.fn(async () => {}),
      kill: vi.fn(async () => true),
      reportSubagentCompletion: vi.fn(),
      getReadScopeInputs: vi.fn(() => ({ parentCwd: opts?.cwd })),
    };
  }),
}));

vi.mock('../routing-telemetry.js', () => ({ appendRoutingDecision: vi.fn(async () => {}) }));

let tmp: string;
let sessionDir: string;
let skillsDir: string;

beforeEach(() => {
  forks.calls.length = 0;
  tmp = mkdtempSync(join(tmpdir(), 'afk-skill-cwd-'));
  // sessionDir is deliberately different from process.cwd() to prove the fix.
  sessionDir = join(tmp, 'session');
  skillsDir = join(tmp, 'skills');
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  _resetRegistry();
});

afterEach(() => {
  resetUsageLedgerForTests();
  vi.restoreAllMocks();
  _resetRegistry();
  rmSync(tmp, { recursive: true, force: true });
});

const signal = new AbortController().signal;

/** Build a recording gate factory that captures origins. */
function recordingGate(): {
  factory: (o: ChildToolOrigin) => CanUseTool;
  origins: ChildToolOrigin[];
} {
  const origins: ChildToolOrigin[] = [];
  return {
    origins,
    factory: (origin) => {
      origins.push(origin);
      return async () => ({ behavior: 'allow' });
    },
  };
}

/** Register a `context: fork` disk skill under skillsDir/<name>/SKILL.md. */
function registerForkSkill(name: string): void {
  const skillDir = join(skillsDir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: test fork skill\ncontext: fork\n---\nList the files here.\n`,
  );
  expect(scanSkillsFromDir(skillsDir, 'project')).toBeGreaterThanOrEqual(1);
}

describe('user-skills.ts makeUserSkillHandler: child runs in session directory', () => {
  it('passes sessionCwd to the SubagentManager so the child cwd is the session dir, not process.cwd()', async () => {
    registerForkSkill('fork-cwd-probe');
    const skill = registerSkill.length; // keep TS happy; skill is registered via scanSkillsFromDir
    void skill;
    const { getSkill } = await import('../../skills/skill-registry.js');
    const forkSkill = getSkill('fork-cwd-probe');

    const ctx: SkillExecutionContext = {
      defaultSubagentModel: 'sonnet',
      sessionCwd: sessionDir,
    };

    // Handler throws from recorder; we catch and inspect the capture.
    await forkSkill.handler('', { sessionId: 'parent', abortSignal: signal } as never, ctx)
      .catch(() => { /* recorder throws — expected */ });

    expect(forks.calls).toHaveLength(1);
    const call = forks.calls[0]!;
    // The manager MUST receive the session cwd, not undefined (process.cwd()).
    expect(call.managerCwd).toBe(sessionDir);
  });

  it('without sessionCwd the manager cwd is undefined (process.cwd() fallback, unchanged behaviour)', async () => {
    registerForkSkill('fork-nocwd-probe');
    const { getSkill } = await import('../../skills/skill-registry.js');
    const forkSkill = getSkill('fork-nocwd-probe');

    const ctx: SkillExecutionContext = {
      defaultSubagentModel: 'sonnet',
      // No sessionCwd — simulates surfaces that do not carry it.
    };

    await forkSkill.handler('', { sessionId: 'parent', abortSignal: signal } as never, ctx)
      .catch(() => {});

    expect(forks.calls).toHaveLength(1);
    expect(forks.calls[0]!.managerCwd).toBeUndefined();
  });
});

describe('inlineSkillChildGate: origin carries the cwd', () => {
  it('when cwd is passed the returned gate factory produces origins with that cwd', () => {
    const g = recordingGate();
    const gate = inlineSkillChildGate(g.factory, 1, sessionDir);
    expect(gate).toBeDefined();
    gate!('my-skill');
    expect(g.origins).toHaveLength(1);
    expect(g.origins[0]).toEqual({ route: 'skill', depth: 1, agentType: 'my-skill', cwd: sessionDir });
  });

  it('without cwd the origin has no cwd property', () => {
    const g = recordingGate();
    const gate = inlineSkillChildGate(g.factory, 1);
    gate!('my-skill');
    expect(g.origins[0]).toEqual({ route: 'skill', depth: 1, agentType: 'my-skill' });
    expect('cwd' in g.origins[0]!).toBe(false);
  });

  it('returns undefined when factory is undefined', () => {
    expect(inlineSkillChildGate(undefined, 1, sessionDir)).toBeUndefined();
  });
});

describe('inlineChildGateOpt: origin carries the cwd', () => {
  it('passes cwd through to the underlying inlineSkillChildGate', () => {
    const g = recordingGate();
    const factory = createChildProviderFactory({ childCanUseTool: g.factory });
    const opt = inlineChildGateOpt(factory, 1, sessionDir);
    expect(opt).toHaveProperty('childGate');
    (opt as { childGate: (t: string) => CanUseTool | undefined }).childGate('probe-skill');
    expect(g.origins).toHaveLength(1);
    expect(g.origins[0]).toMatchObject({ route: 'skill', depth: 1, agentType: 'probe-skill', cwd: sessionDir });
  });

  it('without cwd the origin carries no cwd', () => {
    const g = recordingGate();
    const factory = createChildProviderFactory({ childCanUseTool: g.factory });
    const opt = inlineChildGateOpt(factory, 1);
    (opt as { childGate: (t: string) => CanUseTool | undefined }).childGate('probe-skill');
    expect('cwd' in g.origins[0]!).toBe(false);
  });
});

describe('SkillExecutor: sessionCwd forwarded to inline handler and gate origin', () => {
  it('forwards currentCwd as sessionCwd in the SkillExecutionContext', async () => {
    let seenCtx: SkillExecutionContext | undefined;
    registerSkill({
      name: 'ctx-cwd-probe',
      description: 'probe',
      handler: async (_i, _s, ctx) => { seenCtx = ctx; return 'ok'; },
    });

    const ex = new SkillExecutor({
      parentSession: {
        sessionId: 'root',
        getInputStreamRef: () => ({ pushUserMessage: () => {} }),
        abortSignal: signal,
      } as never,
      defaultModel: 'sonnet',
      defaultSubagentModel: 'sonnet',
      depth: 0,
      maxDepth: 3,
      cwd: sessionDir,
      childProviderFactory: createChildProviderFactory({}),
    } as ConstructorParameters<typeof SkillExecutor>[0]);

    await ex.execute({ id: 's', name: 'skill', input: { name: 'ctx-cwd-probe' }, signal });

    expect(seenCtx).toBeDefined();
    expect(seenCtx!.sessionCwd).toBe(sessionDir);
  });

  it('forwards currentCwd into the gate origin via inlineChildGateOpt', async () => {
    const g = recordingGate();
    let seenCtx: SkillExecutionContext | undefined;
    registerSkill({
      name: 'gate-cwd-probe',
      description: 'probe',
      handler: async (_i, _s, ctx) => { seenCtx = ctx; return 'ok'; },
    });

    const ex = new SkillExecutor({
      parentSession: {
        sessionId: 'root',
        getInputStreamRef: () => ({ pushUserMessage: () => {} }),
        abortSignal: signal,
      } as never,
      defaultModel: 'sonnet',
      defaultSubagentModel: 'sonnet',
      depth: 0,
      maxDepth: 3,
      cwd: sessionDir,
      childProviderFactory: createChildProviderFactory({ childCanUseTool: g.factory }),
    } as ConstructorParameters<typeof SkillExecutor>[0]);

    await ex.execute({ id: 's', name: 'skill', input: { name: 'gate-cwd-probe' }, signal });

    expect(seenCtx?.childGate).toBeDefined();
    seenCtx!.childGate!('inline-fork-skill');
    expect(g.origins).toHaveLength(1);
    expect(g.origins[0]).toMatchObject({ route: 'skill', depth: 1, agentType: 'inline-fork-skill', cwd: sessionDir });
  });

  it('no sessionCwd when executor has no cwd', async () => {
    let seenCtx: SkillExecutionContext | undefined;
    registerSkill({
      name: 'no-cwd-probe',
      description: 'probe',
      handler: async (_i, _s, ctx) => { seenCtx = ctx; return 'ok'; },
    });

    const ex = new SkillExecutor({
      parentSession: {
        sessionId: 'root',
        getInputStreamRef: () => ({ pushUserMessage: () => {} }),
        abortSignal: signal,
      } as never,
      defaultModel: 'sonnet',
      defaultSubagentModel: 'sonnet',
      depth: 0,
      maxDepth: 3,
      // No cwd — simulates older surfaces.
      childProviderFactory: createChildProviderFactory({}),
    } as ConstructorParameters<typeof SkillExecutor>[0]);

    await ex.execute({ id: 's', name: 'skill', input: { name: 'no-cwd-probe' }, signal });

    expect(seenCtx).toBeDefined();
    expect('sessionCwd' in seenCtx!).toBe(false);
  });
});
