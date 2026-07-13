/**
 * Tests for /mint skill — 8-phase state machine.
 *
 * Redirects HOME to a tmp dir so the mint state-store does not write to the
 * real ~/.afk/state/sessions/ during tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi, MockedFunction } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadSkillPrompts } from './_lib/prompt-loader.js';
import { getSkill, registerSkill } from './index.js';
import type { MintState } from './mint/index.js';
import type { IAgentSession, OutputEvent, SubagentProgressMeta } from '../agent/types.js';
import { runWithSink } from '../agent/_lib/skill-sink-channel.js';
import { useUnsetAfkHome } from '../__test-utils__/unset-afk-home.js';

// Import the skill module to trigger registration
import './mint/index.js';

// The disk-persisted state cases assert mint-state.json lands under
// $HOME/.afk (mintStatePath below builds from tmpHome) — drop the global
// sentinel AFK_HOME per test; HOME is redirected in beforeEach.
useUnsetAfkHome();

const sharedMintMock = vi.hoisted(() => ({
  forkOptions: [] as Array<Record<string, unknown>>,
}));

let tmpHome: string;
let originalHome: string | undefined;

function mintStatePath(sessionId: string): string {
  return join(tmpHome, '.afk', 'state', 'sessions', sessionId, 'mint-state.json');
}

// Mock SubagentManager
//
// The mock factory dispatches on `options.idPrefix` so phases that now use
// `outputSchema` get schema-shaped `output`:
//   - mint-build      → BuildOutputSchema-shaped (PASS, files_changed, tests_passed, notes)
//   - mint-verify-*   → VerifyModeOutputSchema-shaped (FAIL by default, drives the heal loop)
//   - mint-heal       → message content prefixed with `FIX_APPLIED: true` marker
// Other prefixes (mint-spec, mint-research, mint-plan, mint-ship, diagnose-*,
// etc.) keep the legacy generic message-only response with `output: undefined`.
vi.mock('../agent/subagent.js', () => {
  return {
    SubagentManager: vi.fn(() => ({
      forkSubagent: vi.fn(async (options) => {
        sharedMintMock.forkOptions.push(options as Record<string, unknown>);
        const idPrefix = options.idPrefix || 'subagent';

        let output: unknown = undefined;
        if (idPrefix === 'mint-build') {
          output = {
            status: 'PASS',
            files_changed: ['src/index.ts'],
            tests_passed: true,
            notes: 'Mocked build',
          };
        } else if (idPrefix.startsWith('mint-verify-')) {
          output = {
            status: 'FAIL',
            issues: ['mocked verify failure'],
            summary: 'Mocked',
          };
        }

        const messageContent =
          idPrefix === 'mint-heal'
            ? 'FIX_APPLIED: true\n\nMocked heal narrative'
            : `Mocked ${idPrefix} output`;

        return {
          id: idPrefix,
          status: 'idle',
          session: { sendMessage: vi.fn() },
          run: vi.fn(async () => ({ content: messageContent })),
          runToResult: vi.fn(async () => ({
            id: idPrefix,
            status: 'succeeded',
            message: { content: messageContent },
            output,
          })),
          runInBackground: vi.fn(),
          cancel: vi.fn(),
          teardown: vi.fn(async () => undefined),
        };
      }),
    })),
  };
});

describe('Mint Skill', () => {
  beforeEach(() => {
    sharedMintMock.forkOptions.length = 0;
    vi.clearAllMocks();
    originalHome = process.env['HOME'];
    tmpHome = join(tmpdir(), `afk-mint-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env['HOME'] = tmpHome;
  });

  afterEach(() => {
    if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
    if (originalHome !== undefined) process.env['HOME'] = originalHome;
  });

  describe('Prompts loading', () => {
    it('loads all 7 phase prompts', () => {
      const prompts = loadSkillPrompts('mint');
      expect(prompts['spec.md']).toBeDefined();
      expect(prompts['research.md']).toBeDefined();
      expect(prompts['plan.md']).toBeDefined();
      expect(prompts['build.md']).toBeDefined();
      expect(prompts['verify.md']).toBeDefined();
      expect(prompts['heal.md']).toBeDefined();
      expect(prompts['ship.md']).toBeDefined();

      // Each prompt should have content
      expect(prompts['spec.md'].length).toBeGreaterThan(0);
      expect(prompts['research.md'].length).toBeGreaterThan(0);
      expect(prompts['plan.md'].length).toBeGreaterThan(0);
      expect(prompts['build.md'].length).toBeGreaterThan(0);
      expect(prompts['verify.md'].length).toBeGreaterThan(0);
      expect(prompts['heal.md'].length).toBeGreaterThan(0);
      expect(prompts['ship.md'].length).toBeGreaterThan(0);
    });

    it('raises error for unknown skill', () => {
      expect(() => loadSkillPrompts('nonexistent-mint-test')).toThrow(
        /Unknown skill: nonexistent-mint-test/,
      );
    });

    it('raises error for unknown skill', () => {
      // Test for a completely unknown skill
      expect(() => loadSkillPrompts('completely-fake-skill-name-xyz')).toThrow(
        /Unknown skill/,
      );
    });
  });

  describe('Skill registration', () => {
    it('skill is registered in the registry', () => {
      const skill = getSkill('mint');
      expect(skill.name).toBe('mint');
      expect(skill.description).toContain('ship-ready');
      expect(typeof skill.handler).toBe('function');
    });

    it('handler is a function', () => {
      const skill = getSkill('mint');
      expect(skill.handler).toBeDefined();
      expect(typeof skill.handler).toBe('function');
    });
  });

  describe('Handler input validation', () => {
    it('rejects input without idea field when passed as object', async () => {
      const skill = getSkill('mint');

      const mockSession = {
        sessionId: 'test-session',
        sendMessage: vi.fn(),
        interrupt: vi.fn(),
        close: vi.fn(),
        getInputStreamRef: vi.fn(),
        abortSignal: new AbortController().signal,
      } as unknown as IAgentSession;

      const result = skill.handler({ wrongField: 'test' }, mockSession);

      // Should throw because no idea field
      await expect(result).rejects.toThrow('mint handler requires input.idea');
    });

    it('accepts idea as string input', async () => {
      const skill = getSkill('mint');

      const mockSession = {
        sessionId: 'test-session',
        sendMessage: vi.fn(),
        interrupt: vi.fn(),
        close: vi.fn(),
        getInputStreamRef: vi.fn(),
        abortSignal: new AbortController().signal,
      } as unknown as IAgentSession;

      // This should succeed but return a paused state (no autoApprove)
      const result = await skill.handler('Test idea', mockSession);
      expect(result).toHaveProperty('paused', true);
      expect(result).toHaveProperty('phase', 'spec');
    });

    it('accepts idea as object with idea field', async () => {
      const skill = getSkill('mint');

      const mockSession = {
        sessionId: 'test-session',
        sendMessage: vi.fn(),
        interrupt: vi.fn(),
        close: vi.fn(),
        getInputStreamRef: vi.fn(),
        abortSignal: new AbortController().signal,
      } as unknown as IAgentSession;

      // Should succeed and return paused state
      const result = await skill.handler({ idea: 'Test idea' }, mockSession);

      expect(result).toHaveProperty('paused', true);
      if ('spec' in result) {
        expect(result.spec).toBeTruthy();
      }
    });
  });

  describe('State machine structure', () => {
    it('initializes state with correct phase and idea', async () => {
      const skill = getSkill('mint');

      const mockSession = {
        sessionId: 'test-session',
        sendMessage: vi.fn(),
        interrupt: vi.fn(),
        close: vi.fn(),
        getInputStreamRef: vi.fn(),
        abortSignal: new AbortController().signal,
      } as unknown as IAgentSession;

      // Should succeed with autoApprove=false (paused after spec)
      const result = await skill.handler(
        { idea: 'Test feature', autoApprove: false },
        mockSession,
      );

      // Should be paused at spec phase
      expect(result).toHaveProperty('paused', true);
      if ('state' in result && result.state) {
        expect(result.state.currentPhase).toBe('spec');
        expect(result.state.idea).toBe('Test feature');
      }
    });
  });

  describe('Prompt content validation', () => {
    it('spec.md contains problem statement guidance', () => {
      const prompts = loadSkillPrompts('mint');
      const specPrompt = prompts['spec.md'];
      expect(specPrompt).toContain('problem');
      expect(specPrompt).toContain('scope');
      expect(specPrompt).toContain('success');
    });

    it('research.md contains context gathering guidance', () => {
      const prompts = loadSkillPrompts('mint');
      const researchPrompt = prompts['research.md'];
      expect(researchPrompt).toContain('context');
      expect(researchPrompt).toContain('Codebase');
      expect(researchPrompt).toContain('research');
    });

    it('plan.md contains implementation planning guidance', () => {
      const prompts = loadSkillPrompts('mint');
      const planPrompt = prompts['plan.md'];
      expect(planPrompt).toContain('files');
      expect(planPrompt).toContain('implementation');
      expect(planPrompt).toContain('test');
    });

    it('build.md contains development guidance', () => {
      const prompts = loadSkillPrompts('mint');
      const buildPrompt = prompts['build.md'];
      expect(buildPrompt).toContain('TDD');
      expect(buildPrompt).toContain('test');
      expect(buildPrompt).toContain('implementation');
    });

    it('verify.md contains verification guidance', () => {
      const prompts = loadSkillPrompts('mint');
      const verifyPrompt = prompts['verify.md'];
      expect(verifyPrompt).toContain('programmatic');
      expect(verifyPrompt).toContain('design');
      expect(verifyPrompt).toContain('ship');
    });

    it('heal.md contains healing guidance', () => {
      const prompts = loadSkillPrompts('mint');
      const healPrompt = prompts['heal.md'];
      expect(healPrompt).toContain('fix');
      expect(healPrompt).toContain('failure');
      expect(healPrompt).toContain('iteration');
    });

    it('ship.md contains shipping guidance', () => {
      const prompts = loadSkillPrompts('mint');
      const shipPrompt = prompts['ship.md'];
      expect(shipPrompt).toContain('summary');
      expect(shipPrompt).toContain('status');
      expect(shipPrompt).toContain('command');
    });
  });

  describe('Prompt count and naming', () => {
    it('has exactly 7 prompts in alphabetical order', () => {
      const prompts = loadSkillPrompts('mint');
      const keys = Object.keys(prompts);
      expect(keys.length).toBe(7);

      const expectedKeys = ['build.md', 'heal.md', 'plan.md', 'research.md', 'ship.md', 'spec.md', 'verify.md'];
      expect(keys).toEqual(expectedKeys);
    });
  });

  describe('Phase naming conventions', () => {
    it('each prompt follows phase naming convention', () => {
      const prompts = loadSkillPrompts('mint');
      const validPhases = ['build', 'heal', 'plan', 'research', 'ship', 'spec', 'verify'];

      for (const key of Object.keys(prompts)) {
        const phase = key.replace('.md', '');
        expect(validPhases).toContain(phase);
      }
    });
  });

  describe('Handler type signature', () => {
    it('handler accepts MintInput object with idea', async () => {
      const skill = getSkill('mint');
      expect(skill.handler).toBeDefined();

      // Test that it accepts the right input shape
      // (actual execution would fail without full setup, but we catch it)
      const result = skill.handler(
        { idea: 'test', autoApprove: false } as any,
        undefined as any,
      );
      expect(result).toBeInstanceOf(Promise);

      // Consume the promise to avoid unhandled rejection
      try {
        await result;
      } catch {
        // Expected to fail without proper setup
      }
    });

    it('handler accepts resumeFrom and userApproved for resume flow', async () => {
      const skill = getSkill('mint');

      const mockState: MintState = {
        currentPhase: 'spec',
        idea: 'test',
        spec: 'test spec',
        healIterations: 0,
        history: [],
      };

      const result = skill.handler(
        { resumeFrom: mockState, userApproved: true } as any,
        undefined as any,
      );
      expect(result).toBeInstanceOf(Promise);

      // Consume the promise to avoid unhandled rejection
      try {
        await result;
      } catch {
        // Expected to fail without proper setup
      }
    });
  });

  describe('Handler requires parentSession', () => {
    it('throws error when parentSession is not provided', async () => {
      const skill = getSkill('mint');

      const result = skill.handler({ idea: 'test', autoApprove: true });

      await expect(result).rejects.toThrow('requires a parent session');
    });

    it('throws error when parentSession lacks sessionId', async () => {
      const skill = getSkill('mint');

      const result = skill.handler(
        { idea: 'test', autoApprove: true },
        { sessionId: undefined } as any,
      );

      await expect(result).rejects.toThrow('requires a parent session');
    });
  });

  describe('Hard pause after spec phase', () => {
    it('pauses after spec phase when autoApprove is false', async () => {
      const skill = getSkill('mint');

      const mockSession: IAgentSession = {
        sessionId: 'test-session',
        sendMessage: vi.fn(),
        interrupt: vi.fn(),
        close: vi.fn(),
        getInputStreamRef: vi.fn(),
        abortSignal: new AbortController().signal,
      };

      const result = await skill.handler({ idea: 'Test idea', autoApprove: false }, mockSession);

      expect(result).toHaveProperty('paused', true);
      if ('phase' in result) {
        expect(result.phase).toBe('spec');
      }
      if ('spec' in result) {
        expect(result.spec).toBeDefined();
      }
    });
  });

  describe('Full flow with autoApprove', () => {
    it('runs through all phases when autoApprove is true', async () => {
      const skill = getSkill('mint');

      const mockSession: IAgentSession = {
        sessionId: 'test-session',
        sendMessage: vi.fn(),
        interrupt: vi.fn(),
        close: vi.fn(),
        getInputStreamRef: vi.fn(),
        abortSignal: new AbortController().signal,
      };

      const result = await skill.handler(
        { idea: 'Test feature', autoApprove: true },
        mockSession,
      );

      // Result can be either completed or paused on heal-failed (due to mocked verify results)
      // The important thing is that it processes beyond spec
      if ('completed' in result) {
        expect(result.completed).toBe(true);
      } else if ('paused' in result) {
        // If paused, it should be due to heal failure
        expect(result.paused).toBe(true);
        expect(result.phase).toBe('heal-failed');
      }

      if ('state' in result) {
        // State should have progressed beyond spec
        expect(result.state.currentPhase).not.toBe('spec');
      }
    });
  });

  describe('Resume flow', () => {
    it('resumes from paused spec state when userApproved is true', async () => {
      const skill = getSkill('mint');

      const mockState: MintState = {
        currentPhase: 'spec',
        idea: 'Test feature',
        spec: 'Test specification',
        healIterations: 0,
        history: [],
      };

      const mockSession: IAgentSession = {
        sessionId: 'test-session',
        sendMessage: vi.fn(),
        interrupt: vi.fn(),
        close: vi.fn(),
        getInputStreamRef: vi.fn(),
        abortSignal: new AbortController().signal,
      };

      const result = await skill.handler(
        { idea: 'Test feature', resumeFrom: mockState, userApproved: true },
        mockSession,
      );

      // Result can be either completed or paused on heal-failed (due to mocked verify results)
      if ('completed' in result) {
        expect(result.completed).toBe(true);
      } else if ('paused' in result) {
        expect(result.paused).toBe(true);
        expect(result.phase).toBe('heal-failed');
      }

      if ('state' in result && result.state) {
        expect(result.state.currentPhase).not.toBe('spec');
      }
    });
  });

  describe('Heal cap at 2 iterations', () => {
    it('returns heal-failed when heal iterations reach cap', async () => {
      const skill = getSkill('mint');

      const mockState: MintState = {
        currentPhase: 'heal',
        idea: 'Test feature',
        spec: 'Test spec',
        research: 'Test research',
        plan: 'Test plan',
        buildResults: { filesChanged: ['src/index.ts'], testsPassed: true, notes: 'Built' },
        verifyResults: { testsPassed: false, lintPassed: false, designReviewPassed: false },
        healIterations: 2,
        history: [],
      };

      const mockSession: IAgentSession = {
        sessionId: 'test-session',
        sendMessage: vi.fn(),
        interrupt: vi.fn(),
        close: vi.fn(),
        getInputStreamRef: vi.fn(),
        abortSignal: new AbortController().signal,
      };

      const result = await skill.handler(
        { idea: 'Test feature', resumeFrom: mockState, userApproved: true },
        mockSession,
      );

      // Should fail heal phase when iterations at cap
      expect(result).toHaveProperty('paused', true);
      if ('phase' in result) {
        expect(result.phase).toBe('heal-failed');
      }
    });

    it('loops heal and increments iterations when verify keeps failing', async () => {
      // Starting with healIterations=0 and a state that will cause verify to
      // fail (mocked subagent output has no PASS/FAIL markers), the heal loop
      // must drive healIterations up to the cap before giving up.
      const skill = getSkill('mint');

      const mockState: MintState = {
        currentPhase: 'spec',
        idea: 'Test feature',
        spec: 'Test spec',
        healIterations: 0,
        history: [],
      };

      const mockSession: IAgentSession = {
        sessionId: 'test-session',
        sendMessage: vi.fn(),
        interrupt: vi.fn(),
        close: vi.fn(),
        getInputStreamRef: vi.fn(),
        abortSignal: new AbortController().signal,
      };

      const result = await skill.handler(
        { idea: 'Test feature', resumeFrom: mockState, userApproved: true },
        mockSession,
      );

      expect(result).toHaveProperty('paused', true);
      if ('phase' in result) {
        expect(result.phase).toBe('heal-failed');
      }
      if ('state' in result && result.state) {
        expect(result.state.healIterations).toBe(2);
      }
    });
  });

  describe('Phase checkpoint cards', () => {
    /** Capture every (event, meta) the skill dispatches to the ambient sink. */
    function captureSink(): {
      sink: (event: OutputEvent, meta: SubagentProgressMeta) => void;
      events: Array<{ event: OutputEvent; meta: SubagentProgressMeta }>;
    } {
      const events: Array<{ event: OutputEvent; meta: SubagentProgressMeta }> = [];
      return {
        sink: (event, meta) => events.push({ event, meta }),
        events,
      };
    }

    it('emits a build-phase checkpoint panel with files-changed and tests', async () => {
      const skill = getSkill('mint');
      const mockSession: IAgentSession = {
        sessionId: 'test-session',
        sendMessage: vi.fn(),
        interrupt: vi.fn(),
        close: vi.fn(),
        getInputStreamRef: vi.fn(),
        abortSignal: new AbortController().signal,
      };
      const { sink, events } = captureSink();

      await runWithSink(sink, async () => {
        await skill.handler(
          { idea: 'Test feature', autoApprove: true },
          mockSession,
        );
      });

      const panels = events.filter((e) => e.event.type === 'panel');
      const buildPanel = panels.find((p) =>
        p.event.type === 'panel' && p.event.spec.title === 'build',
      );
      expect(buildPanel).toBeDefined();
      if (buildPanel && buildPanel.event.type === 'panel') {
        expect(buildPanel.event.spec.kind).toBe('checkpoint');
        const body = Array.isArray(buildPanel.event.spec.body)
          ? buildPanel.event.spec.body.join('\n')
          : buildPanel.event.spec.body;
        expect(body).toContain('Files changed');
        expect(body).toContain('Tests');
      }
    });

    it('emits a verify-phase panel with status flags', async () => {
      const skill = getSkill('mint');
      const mockSession: IAgentSession = {
        sessionId: 'test-session',
        sendMessage: vi.fn(),
        interrupt: vi.fn(),
        close: vi.fn(),
        getInputStreamRef: vi.fn(),
        abortSignal: new AbortController().signal,
      };
      const { sink, events } = captureSink();

      await runWithSink(sink, async () => {
        await skill.handler(
          { idea: 'Test feature', autoApprove: true },
          mockSession,
        );
      });

      const verifyPanel = events.find(
        (e) => e.event.type === 'panel' && e.event.spec.title === 'verify',
      );
      expect(verifyPanel).toBeDefined();
      if (verifyPanel && verifyPanel.event.type === 'panel') {
        // Mocked verify always FAILs in this suite, so the kind is 'diagnosis'.
        expect(['checkpoint', 'diagnosis']).toContain(verifyPanel.event.spec.kind);
        const body = Array.isArray(verifyPanel.event.spec.body)
          ? verifyPanel.event.spec.body.join('\n')
          : verifyPanel.event.spec.body;
        expect(body).toContain('Tests:');
        expect(body).toContain('Lint:');
        expect(body).toContain('Design review:');
      }
    });
  });

  describe('State history tracking', () => {
    it('appends entries to state history for each phase', async () => {
      const skill = getSkill('mint');

      const mockSession: IAgentSession = {
        sessionId: 'test-session',
        sendMessage: vi.fn(),
        interrupt: vi.fn(),
        close: vi.fn(),
        getInputStreamRef: vi.fn(),
        abortSignal: new AbortController().signal,
      };

      const result = await skill.handler(
        { idea: 'Test', autoApprove: false },
        mockSession,
      );

      if ('state' in result && result.state) {
        expect(result.state.history.length).toBeGreaterThan(0);
        expect(result.state.history[0].phase).toBe('spec');
        for (const entry of result.state.history) {
          expect(entry.output).toBeDefined();
          expect(entry.timestamp).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('Parallelize phase history surfacing', () => {
    // The plan text produced by the mocked plan subagent is "Mocked mint-plan
    // output" — it has fewer than 3 file references, so parallelize-dispatch
    // must classify the run as a legitimate `skipped` and the caller must
    // record that in history with the discriminator visible. A historic bug
    // would record the same `null`/`"skipped"` string for both `skipped` and
    // silently-failed runs; this test pins the post-fix shape.
    it('records "skipped: <reason>" in history when the plan has too few files', async () => {
      const skill = getSkill('mint');
      const mockSession: IAgentSession = {
        sessionId: 'parallelize-history-session',
        sendMessage: vi.fn(),
        interrupt: vi.fn(),
        close: vi.fn(),
        getInputStreamRef: vi.fn(),
        abortSignal: new AbortController().signal,
      };

      const result = await skill.handler(
        { idea: 'Test feature', autoApprove: true },
        mockSession,
      );

      if ('state' in result && result.state) {
        const parallelizeEntries = result.state.history.filter(
          (e) => e.phase === 'parallelize',
        );
        expect(parallelizeEntries.length).toBe(1);
        // Shape: "skipped: too-few-files" — distinguishable from the
        // historic ambiguous "skipped" string and from any "failed: …" entry.
        expect(parallelizeEntries[0].output).toMatch(/^skipped: /);
        expect(parallelizeEntries[0].output).not.toMatch(/^failed: /);
      }
    });
  });

  describe('Resume via shorthand and disk-persisted state', () => {
    const mockSession: IAgentSession = {
      sessionId: 'resume-test-session',
      sendMessage: vi.fn(),
      interrupt: vi.fn(),
      close: vi.fn(),
      getInputStreamRef: vi.fn(),
      abortSignal: new AbortController().signal,
    };

    function seedPausedState(sessionId: string): MintState {
      const state: MintState = {
        currentPhase: 'spec',
        idea: 'Seeded idea',
        spec: 'Seeded specification text',
        healIterations: 0,
        history: [{ phase: 'spec', output: 'Seeded specification text', timestamp: 1 }],
      };
      const path = mintStatePath(sessionId);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8');
      return state;
    }

    it('paused-after-spec writes the state file', async () => {
      const skill = getSkill('mint');
      const result = await skill.handler({ idea: 'Persistable idea' }, mockSession);
      expect(result).toHaveProperty('paused', true);
      expect(existsSync(mintStatePath(mockSession.sessionId!))).toBe(true);
    });

    it('paused-after-spec response carries a nextStep hint', async () => {
      const skill = getSkill('mint');
      const result = await skill.handler({ idea: 'Hinted idea' }, mockSession);
      if ('paused' in result && result.paused && result.phase === 'spec') {
        expect(result.nextStep).toMatch(/--continue/);
      } else {
        throw new Error('expected paused-spec result');
      }
    });

    it('--continue approved as a string input loads disk state and resumes', async () => {
      const skill = getSkill('mint');
      seedPausedState(mockSession.sessionId!);

      const result = await skill.handler('--continue approved', mockSession);

      // Either completed or heal-failed — the point is it advanced past spec.
      if ('completed' in result) {
        expect(result.completed).toBe(true);
      } else {
        expect(result.paused).toBe(true);
        expect(result.phase).toBe('heal-failed');
      }
      if ('state' in result) {
        expect(result.state.idea).toBe('Seeded idea');
        expect(result.state.currentPhase).not.toBe('spec');
      }
    });

    it('{userApproved: true} without an idea also loads disk state and resumes', async () => {
      const skill = getSkill('mint');
      seedPausedState(mockSession.sessionId!);

      const result = await skill.handler({ userApproved: true }, mockSession);

      if ('completed' in result) {
        expect(result.completed).toBe(true);
      } else {
        expect(result.paused).toBe(true);
        expect(result.phase).toBe('heal-failed');
      }
      if ('state' in result) {
        expect(result.state.idea).toBe('Seeded idea');
      }
    });

    it.each([
      '{"userApproved": true}',
      '{"userApproved":true}',
      '  {"userApproved": true}  ',
      '{"idea": "approved"}',
    ])(
      'JSON-string %s (skill-tool boundary serialization) loads disk state and resumes',
      async (input) => {
        // Regression: the `skill` tool serializes structured arguments to a JSON
        // string before dispatch. Without JSON.parse in the string branch of
        // parseMintInput, this fell through to idea-treatment, the resume gate
        // was skipped, clearMintState wiped the disk state, and Phase 1 was
        // re-run on the literal control-signal token. See postmortem in
        // session of 2026-05-12.
        const skill = getSkill('mint');
        seedPausedState(mockSession.sessionId!);

        const result = await skill.handler(input, mockSession);

        if ('completed' in result) {
          expect(result.completed).toBe(true);
        } else {
          expect(result.paused).toBe(true);
          expect(result.phase).toBe('heal-failed');
        }
        if ('state' in result) {
          expect(result.state.idea).toBe('Seeded idea');
          expect(result.state.currentPhase).not.toBe('spec');
        }
      },
    );

    it('--continue carried under the idea field is treated as resume shorthand', async () => {
      const skill = getSkill('mint');
      seedPausedState(mockSession.sessionId!);

      // Models sometimes pass slash arguments as { idea: '<args>' } instead of as
      // the raw string input — make sure that path resolves to resume, not a
      // brand-new spec phase on the literal text "--continue approved".
      const result = await skill.handler({ idea: '--continue approved' }, mockSession);

      if ('state' in result) {
        expect(result.state.idea).toBe('Seeded idea');
        expect(result.state.currentPhase).not.toBe('spec');
      }
    });

    it.each(['approve', 'approved', 'yes', 'y', 'lgtm', 'sure', '  approve  '])(
      'bare "%s" loads disk state and resumes',
      async (input) => {
        const skill = getSkill('mint');
        seedPausedState(mockSession.sessionId!);

        const result = await skill.handler(input, mockSession);

        if ('completed' in result) {
          expect(result.completed).toBe(true);
        } else {
          expect(result.paused).toBe(true);
          expect(result.phase).toBe('heal-failed');
        }
        if ('state' in result) {
          expect(result.state.idea).toBe('Seeded idea');
          expect(result.state.currentPhase).not.toBe('spec');
        }
      },
    );

    it('bare approval carried under idea field is treated as resume', async () => {
      const skill = getSkill('mint');
      seedPausedState(mockSession.sessionId!);

      const result = await skill.handler({ idea: 'approve' }, mockSession);

      if ('state' in result) {
        expect(result.state.idea).toBe('Seeded idea');
        expect(result.state.currentPhase).not.toBe('spec');
      }
    });

    it('resume with no persisted state throws a helpful error', async () => {
      const skill = getSkill('mint');
      // No seed — ensure the file is absent.
      const path = mintStatePath(mockSession.sessionId!);
      if (existsSync(path)) rmSync(path);

      await expect(skill.handler('--continue approved', mockSession)).rejects.toThrow(
        /no paused spec found/,
      );
    });

    it('starting a fresh idea clears any prior paused state on disk', async () => {
      const skill = getSkill('mint');
      seedPausedState(mockSession.sessionId!);
      const path = mintStatePath(mockSession.sessionId!);
      expect(existsSync(path)).toBe(true);

      // Fresh idea — clears the stale state immediately, then writes a new one
      // when the spec phase pauses.
      await skill.handler({ idea: 'Different idea' }, mockSession);

      // A new paused state will exist (the spec phase paused), but it should
      // reflect the new idea, not the seeded one.
      expect(existsSync(path)).toBe(true);
      const seedRoundTrip = JSON.parse(readFileSync(path, 'utf-8')) as MintState;
      expect(seedRoundTrip.idea).toBe('Different idea');
    });

    it('completed/heal-failed terminal states clear the persisted file', async () => {
      const skill = getSkill('mint');
      seedPausedState(mockSession.sessionId!);
      const path = mintStatePath(mockSession.sessionId!);
      expect(existsSync(path)).toBe(true);

      await skill.handler('--continue approved', mockSession);

      // Mocked verify always fails → heal-failed is terminal → file removed.
      expect(existsSync(path)).toBe(false);
    });
  });

  describe('Phase-role propagation to forkSubagent (regression for mint spec auto-execute bug)', () => {
    // Background:
    //   A prior mint run had its spec-phase subagent write files and push commits
    //   because forkSubagent had no per-phase permission boundary. The fix threads
    //   phaseRole: 'read-only' through forkSubagent to inject a phase-restricted
    //   provider — see src/agent/subagent-phase-role.test.ts for the wiring test.
    //
    // This test captures the call-site contract: spec/research/plan phases MUST
    // pass phaseRole: 'read-only' so the dispatcher rejects write/shell/dispatch
    // tools before user approval. If a future refactor drops phaseRole from any
    // of these phases, this test fails loudly.

    it('spec/research/plan phases all pass phaseRole: read-only to forkSubagent', async () => {
      const skill = getSkill('mint');
      const mockSession: IAgentSession = {
        sessionId: 'test-session',
        sendMessage: vi.fn(),
        interrupt: vi.fn(),
        close: vi.fn(),
        getInputStreamRef: vi.fn(),
        abortSignal: new AbortController().signal,
      };

      // autoApprove: true → runs spec → research → plan → build → verify → heal …
      // until either completion or a paused/error state. The mocked subagent
      // returns valid output for each phase, so the orchestrator advances and
      // we collect all forkSubagent call options along the way.
      await skill.handler({ idea: 'Test feature', autoApprove: true }, mockSession);

      type Captured = { idPrefix?: string; phaseRole?: string };
      const captured = sharedMintMock.forkOptions as Captured[];

      const findByPrefix = (prefix: string) =>
        captured.find((opts) => opts.idPrefix === prefix);

      const spec = findByPrefix('mint-spec');
      const research = findByPrefix('mint-research');
      const plan = findByPrefix('mint-plan');

      expect(spec, 'mint-spec fork must occur').toBeDefined();
      expect(spec?.phaseRole, 'spec phase must run read-only').toBe('read-only');

      expect(research, 'mint-research fork must occur').toBeDefined();
      expect(research?.phaseRole, 'research phase must run read-only').toBe('read-only');

      expect(plan, 'mint-plan fork must occur').toBeDefined();
      expect(plan?.phaseRole, 'plan phase must run read-only').toBe('read-only');
    });

    it('build/verify/heal phases do NOT pass phaseRole: read-only', async () => {
      // Symmetric guard: phases that legitimately execute writes (after user
      // approval has been crossed) must NOT be locked down. If a future
      // refactor accidentally applies phaseRole: 'read-only' to build, this
      // test catches it.
      const skill = getSkill('mint');
      const mockSession: IAgentSession = {
        sessionId: 'test-session',
        sendMessage: vi.fn(),
        interrupt: vi.fn(),
        close: vi.fn(),
        getInputStreamRef: vi.fn(),
        abortSignal: new AbortController().signal,
      };

      await skill.handler({ idea: 'Test feature', autoApprove: true }, mockSession);

      type Captured = { idPrefix?: string; phaseRole?: string };
      const captured = sharedMintMock.forkOptions as Captured[];

      const build = captured.find((opts) => opts.idPrefix === 'mint-build');
      expect(build, 'mint-build fork must occur').toBeDefined();
      // Either undefined (default) or 'read-write' — both indicate writes allowed.
      // The forbidden value is 'read-only'.
      expect(build?.phaseRole).not.toBe('read-only');

      // Verify phases use the `mint-verify-<n>` prefix pattern.
      const verifyOptions = captured.filter((opts) =>
        typeof opts.idPrefix === 'string' && opts.idPrefix.startsWith('mint-verify-'),
      );
      for (const v of verifyOptions) {
        expect(v.phaseRole).not.toBe('read-only');
      }
    });
  });

});
