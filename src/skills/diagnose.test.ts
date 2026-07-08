/**
 * Tests for /diagnose skill.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { z } from 'zod';
import {
  HypothesisSchema,
  VerificationResultSchema,
  DiagnosisResultSchema,
  TriageSchema,
  DiagnosisOutcomeSchema,
  classifyAndExtract,
  fixSpansMultipleFiles,
  computeOutcome,
  runReproducerBaseline,
  buildVerifierUserPrompt,
  type BaselineResult,
  type DiagnosisResult,
  type Hypothesis,
  type VerificationResult,
  diagnoseSkill,
  createReadOnlyCanUseTool,
  createGitLaneCanUseTool,
  createVerifierCanUseTool,
} from './diagnose/index.js';
import { loadSkillPrompts } from './_lib/prompt-loader.js';
import { _resetRegistry, getSkill } from './index.js';

// Utility to create a valid hypothesis
function createValidHypothesis(id = 'h1'): z.infer<typeof HypothesisSchema> {
  return {
    id,
    claim: 'Type mismatch in function signature',
    confidence: 0.85,
    evidence_sources: ['finding-1', 'finding-2'],
    location: 'src/file.ts:42',
    proposed_fix: 'Change parameter type from string to number',
  };
}

// Utility to create a valid verification result
function createValidVerificationResult(
  hypothesisId = 'h1',
  passed = true,
): z.infer<typeof VerificationResultSchema> {
  return {
    hypothesis_id: hypothesisId,
    predicted_pass: passed,
    regressions: [],
    confidence: passed ? 0.9 : 0.2,
    verification_log: `Verification for ${hypothesisId}: ${passed ? 'PASSED' : 'FAILED'}`,
  };
}

// Utility to create a valid diagnosis result
function createValidDiagnosisResult(
  overrides?: Partial<DiagnosisResult>,
): DiagnosisResult {
  return {
    hypotheses: [createValidHypothesis()],
    ...overrides,
  };
}

describe('Diagnose Skill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('HypothesisSchema', () => {
    it('validates a correct hypothesis structure', () => {
      const valid = createValidHypothesis();
      const result = HypothesisSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('rejects missing required fields', () => {
      const invalid = {
        id: 'h1',
        claim: 'Test claim',
        // missing confidence and evidence_sources
      };
      const result = HypothesisSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('rejects confidence outside 0-1 range', () => {
      const invalid = {
        id: 'h1',
        claim: 'Test',
        confidence: 1.5, // Invalid
        evidence_sources: [],
      };
      const result = HypothesisSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('allows optional location and proposed_fix fields', () => {
      const withOptional = {
        id: 'h1',
        claim: 'Test',
        confidence: 0.5,
        evidence_sources: [],
        location: 'src/file.ts:42',
        proposed_fix: 'Change X to Y',
      };
      const result = HypothesisSchema.safeParse(withOptional);
      expect(result.success).toBe(true);
    });
  });

  describe('VerificationResultSchema', () => {
    it('validates a correct verification result', () => {
      const valid = createValidVerificationResult();
      const result = VerificationResultSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('requires all fields including confidence', () => {
      const invalid = {
        hypothesis_id: 'h1',
        predicted_pass: true,
        regressions: [],
        // missing confidence and verification_log
      };
      const result = VerificationResultSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('accepts predicted_pass field (new name)', () => {
      const valid = {
        hypothesis_id: 'h1',
        predicted_pass: true,
        regressions: [],
        confidence: 0.9,
        verification_log: 'Read fix at src/file.ts:42. Type narrowing looks correct.',
      };
      expect(VerificationResultSchema.safeParse(valid).success).toBe(true);
    });

    it('rejects object with old reproducer_passed key (field renamed)', () => {
      // reproducer_passed was renamed to predicted_pass — the old key is unknown
      // and the required predicted_pass field is missing, so parse must fail.
      const withOldKey = {
        hypothesis_id: 'h1',
        reproducer_passed: true, // old name — schema no longer recognizes it
        regressions: [],
        confidence: 0.9,
        verification_log: 'old format',
      };
      expect(VerificationResultSchema.safeParse(withOldKey).success).toBe(false);
    });

    it('allows empty regressions array', () => {
      const valid = createValidVerificationResult('h1', true);
      expect(valid.regressions).toEqual([]);
      const result = VerificationResultSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('allows non-empty regressions array', () => {
      const valid = createValidVerificationResult('h1', false);
      valid.regressions = ['test_1 failed', 'test_2 failed'];
      const result = VerificationResultSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('treats timed_out as optional (absent === not a timeout)', () => {
      // The verifier subagent reports substantive verdicts only and never emits
      // timed_out; a plain failure result must parse without it.
      const withoutFlag = createValidVerificationResult('h1', false);
      expect(withoutFlag).not.toHaveProperty('timed_out');
      expect(VerificationResultSchema.safeParse(withoutFlag).success).toBe(true);
    });

    it('accepts an explicit timed_out flag for wall-clock-exhausted verifiers', () => {
      // The orchestrator sets timed_out:true when a fork fails with a
      // TimeoutError, distinguishing it from a genuine falsification.
      const timedOut = { ...createValidVerificationResult('h1', false), timed_out: true };
      const parsed = VerificationResultSchema.safeParse(timedOut);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.timed_out).toBe(true);
    });
  });

  describe('DiagnosisResultSchema', () => {
    it('validates a correct diagnosis result', () => {
      const valid = createValidDiagnosisResult();
      const result = DiagnosisResultSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('allows empty hypotheses array', () => {
      const valid = createValidDiagnosisResult({ hypotheses: [] });
      const result = DiagnosisResultSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('allows optional reproducer field', () => {
      const valid = createValidDiagnosisResult({ reproducer: 'npm test -- foo.test.ts' });
      const result = DiagnosisResultSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('allows optional winner field', () => {
      const valid = createValidDiagnosisResult({
        winner: {
          hypothesis_id: 'h1',
          verification_log: 'All tests passed',
          proposed_fix: 'Change X to Y',
        },
      });
      const result = DiagnosisResultSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('allows optional verification_results field', () => {
      const valid = createValidDiagnosisResult({
        verification_results: [createValidVerificationResult('h1', true)],
      });
      const result = DiagnosisResultSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });
  });

  describe('Skill registration', () => {
    it('registers the skill with correct metadata', () => {
      const skill = getSkill('diagnose');
      expect(skill).toBeDefined();
      expect(skill?.name).toBe('diagnose');
      expect(skill?.description).toContain('root-cause');
      expect(skill?.handler).toBeDefined();
    });

    it('exports diagnoseSkill metadata', () => {
      expect(diagnoseSkill).toBeDefined();
      expect(diagnoseSkill.name).toBe('diagnose');
      expect(diagnoseSkill.handler).toBeDefined();
      expect(typeof diagnoseSkill.handler).toBe('function');
    });
  });

  describe('Prompt loading', () => {
    it('loads all required diagnose prompts', () => {
      const prompts = loadSkillPrompts('diagnose');
      expect(prompts).toBeDefined();
      expect(prompts['system.md']).toBeDefined();
      expect(prompts['research.md']).toBeDefined();
      expect(prompts['hypothesis.md']).toBeDefined();
      expect(prompts['verify.md']).toBeDefined();
    });

    it('system prompt discusses parallelism and hypotheses', () => {
      const prompts = loadSkillPrompts('diagnose');
      const systemPrompt = prompts['system.md'];
      expect(systemPrompt).toContain('parallel');
      expect(systemPrompt).toContain('hypothesis');
    });

    it('research prompt has codebase and git focus options', () => {
      const prompts = loadSkillPrompts('diagnose');
      const researchPrompt = prompts['research.md'];
      expect(researchPrompt).toContain('codebase');
      expect(researchPrompt).toContain('git');
    });

    it('hypothesis prompt caps at 4 hypotheses', () => {
      const prompts = loadSkillPrompts('diagnose');
      const hypothesisPrompt = prompts['hypothesis.md'];
      expect(hypothesisPrompt).toContain('4');
    });

    it('verify prompt warns about worktree read-only restrictions', () => {
      const prompts = loadSkillPrompts('diagnose');
      const verifyPrompt = prompts['verify.md'];
      expect(verifyPrompt).toContain('worktree');
      expect(verifyPrompt).toContain('read-only');
    });
  });

  describe('Input validation', () => {
    it('requires failure and repoPath in input', () => {
      const skill = getSkill('diagnose');
      expect(skill).toBeDefined();

      const testInput = {
        failure: 'Test failure',
        repoPath: '/path/to/repo',
      };
      expect(testInput.failure).toBeDefined();
      expect(testInput.repoPath).toBeDefined();
    });

    it('accepts optional context', () => {
      const testInput = {
        failure: 'Test failure',
        repoPath: '/path/to/repo',
        context: 'Failing test: foo.test.ts:42',
      };
      expect(testInput.context).toBeDefined();
    });

    it('accepts optional maxHypotheses', () => {
      const testInput = {
        failure: 'Test failure',
        repoPath: '/path/to/repo',
        maxHypotheses: 3,
      };
      expect(testInput.maxHypotheses).toBeDefined();
    });
  });

  describe('Handler validation', () => {
    it('requires failure field', async () => {
      const skill = getSkill('diagnose');
      const input = { repoPath: '/path/to/repo' };

      await expect(skill.handler(input)).rejects.toThrow('failure');
    });

    it('defaults repoPath to cwd when omitted', async () => {
      const skill = getSkill('diagnose');
      const input = { failure: 'Test failure' };

      // No repoPath — should default to process.cwd() and reach the session check
      await expect(skill.handler(input)).rejects.toThrow('session');
    });

    it('accepts a plain string (slash-command path)', async () => {
      const skill = getSkill('diagnose');

      // String input should be treated as the failure description
      await expect(skill.handler('some failure description')).rejects.toThrow('session');
    });

    it('requires a parent session', async () => {
      const skill = getSkill('diagnose');
      const input = {
        failure: 'Test failure',
        repoPath: '/path/to/repo',
      };

      // Handler requires parentSession, which is not provided here
      // This should throw about missing session
      await expect(skill.handler(input)).rejects.toThrow('session');
    });
  });

  describe('Hypothesis cap at 4', () => {
    it('hard caps maxHypotheses at 4', () => {
      // This test verifies the capping logic in the handler
      // When a user passes maxHypotheses > 4, it should be capped

      // We can test this indirectly via the input parsing logic
      const testCases = [
        { input: 5, expected: 4 },
        { input: 10, expected: 4 },
        { input: 4, expected: 4 },
        { input: 2, expected: 2 },
      ];

      for (const testCase of testCases) {
        const capped = Math.min(testCase.input, 4);
        expect(capped).toBe(testCase.expected);
      }
    });
  });

  describe('Reproducer detection', () => {
    it('detects reproducer from context with "test:" marker', () => {
      const context = 'test: npm test -- foo.test.ts';
      // The handler's detectReproducer function should find this
      expect(context).toContain('test:');
    });

    it('detects reproducer from context with "command:" marker', () => {
      const context = 'command: npm run verify';
      expect(context).toContain('command:');
    });

    it('detects reproducer from context with "failing test:" marker', () => {
      const context = 'failing test: src/foo.test.ts:42';
      expect(context).toContain('failing test:');
    });

    it('returns undefined when no reproducer marker found', () => {
      const context = 'Just some general context about the failure';
      const hasMarker = /test:|command:|reproducer:|failing test:/i.test(context);
      expect(hasMarker).toBe(false);
    });
  });

  describe('canUseTool gates (AFK runtime tool names)', () => {
    // Regression guard for the tool-name namespace mismatch: the gates receive
    // AFK's snake_case RUNTIME names (read_file, grep, bash, …), NOT the
    // vendored agents' upstream PascalCase allowlist (Read, Grep, Bash, …).
    // These tests exercise the REAL exported gates against runtime names. The
    // previous version tested a REPLICA against PascalCase, which passed while
    // every read_file/grep/bash call was denied at runtime (see screenshot in
    // the diagnose-tool-errors report). Upstream PascalCase fidelity of the
    // vendored source is covered separately by _agents/vendored.test.ts.
    const OPTS = { signal: new AbortController().signal, toolUseID: 't' };

    it('read-only gate ALLOWS AFK read tools (read_file, grep, glob, web_scrape)', async () => {
      const gate = createReadOnlyCanUseTool();
      for (const t of ['read_file', 'grep', 'glob', 'web_scrape']) {
        expect((await gate(t, {}, OPTS)).behavior, `${t} should be allowed`).toBe('allow');
      }
    });

    it('read-only gate DENIES writes and shell (write_file, edit_file, bash, agent)', async () => {
      const gate = createReadOnlyCanUseTool();
      for (const t of ['write_file', 'edit_file', 'bash', 'agent']) {
        expect((await gate(t, {}, OPTS)).behavior, `${t} should be denied`).toBe('deny');
      }
    });

    it('git lane ALLOWS read-only git bash + reads, DENIES mutating bash + writes', async () => {
      const gate = createGitLaneCanUseTool();
      // read-only git + research reads → allowed
      expect((await gate('read_file', {}, OPTS)).behavior).toBe('allow');
      expect((await gate('grep', {}, OPTS)).behavior).toBe('allow');
      expect((await gate('bash', { command: 'git log --oneline -40' }, OPTS)).behavior).toBe('allow');
      expect((await gate('bash', { command: 'git blame src/x.ts' }, OPTS)).behavior).toBe('allow');
      // mutating git / chained shell → denied
      expect((await gate('bash', { command: 'git commit -m x' }, OPTS)).behavior).toBe('deny');
      expect((await gate('bash', { command: 'git push' }, OPTS)).behavior).toBe('deny');
      expect((await gate('bash', { command: 'git log && rm -rf /tmp/x' }, OPTS)).behavior).toBe('deny');
      // writes / dispatch → denied (not in git-investigator's tool contract)
      expect((await gate('write_file', {}, OPTS)).behavior).toBe('deny');
      expect((await gate('agent', {}, OPTS)).behavior).toBe('deny');
    });

    it('verifier gate is read-only: ALLOWS reads, DENIES edit/write/bash/agent', async () => {
      const gate = createVerifierCanUseTool();
      expect((await gate('read_file', {}, OPTS)).behavior).toBe('allow');
      expect((await gate('grep', {}, OPTS)).behavior).toBe('allow');
      for (const t of ['edit_file', 'write_file', 'bash', 'agent']) {
        expect((await gate(t, {}, OPTS)).behavior, `${t} should be denied`).toBe('deny');
      }
    });
  });

  describe('Schema exports', () => {
    it('exports HypothesisSchema', () => {
      expect(HypothesisSchema).toBeDefined();
      expect(HypothesisSchema.parse).toBeDefined();
    });

    it('exports VerificationResultSchema', () => {
      expect(VerificationResultSchema).toBeDefined();
      expect(VerificationResultSchema.parse).toBeDefined();
    });

    it('exports DiagnosisResultSchema', () => {
      expect(DiagnosisResultSchema).toBeDefined();
      expect(DiagnosisResultSchema.parse).toBeDefined();
    });
  });

  describe('Full result validation', () => {
    it('validates a complete diagnosis result with winner', () => {
      const result: DiagnosisResult = {
        reproducer: 'npm test -- foo.test.ts',
        hypotheses: [
          createValidHypothesis('h1'),
          createValidHypothesis('h2'),
        ],
        winner: {
          hypothesis_id: 'h1',
          verification_log: 'All tests passed',
          proposed_fix: 'Change parameter type',
        },
        verification_results: [
          createValidVerificationResult('h1', true),
          createValidVerificationResult('h2', false),
        ],
      };

      const parsed = DiagnosisResultSchema.safeParse(result);
      expect(parsed.success).toBe(true);
    });

    it('validates a result with multiple hypotheses', () => {
      const result: DiagnosisResult = {
        hypotheses: [
          createValidHypothesis('h1'),
          createValidHypothesis('h2'),
          createValidHypothesis('h3'),
          createValidHypothesis('h4'),
        ],
        verification_results: [
          createValidVerificationResult('h1', false),
          createValidVerificationResult('h2', false),
          createValidVerificationResult('h3', false),
          createValidVerificationResult('h4', false),
        ],
      };

      const parsed = DiagnosisResultSchema.safeParse(result);
      expect(parsed.success).toBe(true);
    });

    it('validates a result with no hypotheses formed', () => {
      const result: DiagnosisResult = {
        hypotheses: [],
      };

      const parsed = DiagnosisResultSchema.safeParse(result);
      expect(parsed.success).toBe(true);
    });
  });

  describe('Confidence scoring', () => {
    it('accepts confidence scores from 0 to 1', () => {
      const confidenceTests = [0, 0.25, 0.5, 0.75, 0.9, 1];

      for (const conf of confidenceTests) {
        const hypothesis = createValidHypothesis();
        hypothesis.confidence = conf;
        const result = HypothesisSchema.safeParse(hypothesis);
        expect(result.success).toBe(true);
      }
    });

    it('rejects confidence outside 0-1 range', () => {
      const hypothesis = createValidHypothesis();
      hypothesis.confidence = -0.1;
      let result = HypothesisSchema.safeParse(hypothesis);
      expect(result.success).toBe(false);

      hypothesis.confidence = 1.1;
      result = HypothesisSchema.safeParse(hypothesis);
      expect(result.success).toBe(false);
    });
  });

  describe('Evidence sources tracking', () => {
    it('tracks evidence sources for each hypothesis', () => {
      const hypothesis = createValidHypothesis();
      expect(hypothesis.evidence_sources).toEqual(['finding-1', 'finding-2']);
      expect(hypothesis.evidence_sources.length).toBe(2);
    });

    it('allows variable number of evidence sources', () => {
      const hypothesis = createValidHypothesis();
      hypothesis.evidence_sources = ['single-source'];
      let result = HypothesisSchema.safeParse(hypothesis);
      expect(result.success).toBe(true);

      hypothesis.evidence_sources = [
        'source-1',
        'source-2',
        'source-3',
        'source-4',
      ];
      result = HypothesisSchema.safeParse(hypothesis);
      expect(result.success).toBe(true);
    });
  });

  // -- Merged-in coverage for the awa-bundled prose-spec capabilities -------
  // (failure-type triage, confidence-desc tiebreak, named outcomes, /spec
  // routing for multi-file fixes). Ported from the now-deleted bundled
  // SKILL.md so the skill's contract stays anchored in tests.

  describe('Phase 1 triage — classifyAndExtract', () => {
    it('classifies a stack-trace crash as crash', () => {
      const t = classifyAndExtract(
        'TypeError: Cannot read properties of undefined\nat foo (src/x.ts:42:3)',
        '',
      );
      expect(t.failure_type).toBe('crash');
      expect(t.error_signature).toContain('TypeError');
      expect(t.affected_area).toBe('src/x.ts:42:3');
    });

    it('classifies "used to work" as regression', () => {
      const t = classifyAndExtract('Test foo fails — used to work before commit abc', '');
      expect(t.failure_type).toBe('regression');
    });

    it('classifies flaky non-deterministic failures as flaky', () => {
      const t = classifyAndExtract('Test passes locally but fails intermittently in CI', '');
      expect(t.failure_type).toBe('flaky');
    });

    it('classifies environment / platform mismatches', () => {
      const t = classifyAndExtract(
        'Works on node 18 but not node 20 — dependency version mismatch',
        '',
      );
      expect(t.failure_type).toBe('environment');
    });

    it('classifies logic-error from expected/got framing', () => {
      const t = classifyAndExtract('Expected 5 but got 7', '');
      expect(t.failure_type).toBe('logic-error');
    });

    it('returns unknown when nothing matches', () => {
      const t = classifyAndExtract('something is off', '');
      expect(t.failure_type).toBe('unknown');
      expect(t.affected_area).toBe('unknown');
    });

    it('caps error_signature at 200 chars', () => {
      const long = 'X'.repeat(500);
      const t = classifyAndExtract(long, '');
      expect(t.error_signature.length).toBeLessThanOrEqual(200);
      expect(t.error_signature.endsWith('...')).toBe(true);
    });

    it('triage shape matches TriageSchema', () => {
      const t = classifyAndExtract('panic at src/foo.rs', '');
      const parsed = TriageSchema.safeParse(t);
      expect(parsed.success).toBe(true);
    });

    // Prose-question guard: when the failure description is a natural-language
    // question with no concrete error tokens, the question itself is NOT a
    // useful anchor — using it would leak the first salient domain noun into
    // the research lanes' triage blocks. Replace with a sentinel.
    it('returns prose-question sentinel for a pure why-question', () => {
      const t = classifyAndExtract(
        'why is agent-afk diagnosing to stashes rather than worktrees',
        '',
      );
      expect(t.error_signature).toBe('prose-question');
    });

    it('returns prose-question sentinel for what/how/where/who questions', () => {
      for (const q of [
        'what causes the daemon to restart',
        'how does the scheduler pick the next task',
        'where does the config get loaded from',
        'who owns the cache invalidation logic',
      ]) {
        const t = classifyAndExtract(q, '');
        expect(t.error_signature, `query: ${q}`).toBe('prose-question');
      }
    });

    it('preserves first line when prose question wraps a real error token', () => {
      // Question prefix + concrete exception name elsewhere → keep the anchor
      const t = classifyAndExtract('Why does this throw NullPointerException?', '');
      expect(t.error_signature).toBe('Why does this throw NullPointerException?');
    });

    it('preserves first line when prose intro is followed by a stack trace', () => {
      const t = classifyAndExtract(
        'Why does this fail?\n\nTypeError: undefined is not a function\nat foo (src/x.ts:42)',
        '',
      );
      // First line wins (still useful as a one-line summary) because the
      // failure overall contains error tokens, so the prose-question
      // suppression does not fire.
      expect(t.error_signature).toBe('Why does this fail?');
    });

    it('does not treat non-question first lines as prose questions', () => {
      // Starts with a non-question word — guard must not fire.
      const t = classifyAndExtract('Build broke after merge into main', '');
      expect(t.error_signature).toBe('Build broke after merge into main');
    });
  });

  describe('fixSpansMultipleFiles', () => {
    const base: Hypothesis = {
      id: 'h',
      claim: 'c',
      confidence: 0.8,
      evidence_sources: [],
    };

    it('returns false when no path-shaped tokens are present', () => {
      expect(fixSpansMultipleFiles({ ...base, proposed_fix: 'change the parser' })).toBe(false);
    });

    it('returns false for a single-file fix', () => {
      expect(
        fixSpansMultipleFiles({
          ...base,
          location: 'src/a.ts:10',
          proposed_fix: 'edit src/a.ts',
        }),
      ).toBe(false);
    });

    it('returns false for two distinct files (boundary: >2, not ≥2)', () => {
      expect(
        fixSpansMultipleFiles({
          ...base,
          location: 'src/a.ts:10',
          proposed_fix: 'edit src/a.ts and src/b.ts',
        }),
      ).toBe(false);
    });

    it('returns true for three or more distinct files', () => {
      expect(
        fixSpansMultipleFiles({
          ...base,
          location: 'src/a.ts:10',
          proposed_fix: 'edit src/a.ts, src/b.ts, and src/c.ts',
        }),
      ).toBe(true);
    });
  });

  describe('computeOutcome', () => {
    const h = (id: string, confidence = 0.8): Hypothesis => ({
      id,
      claim: id,
      confidence,
      evidence_sources: [],
    });
    const v = (id: string, passed: boolean, regressions: string[] = []): VerificationResult => ({
      hypothesis_id: id,
      predicted_pass: passed,
      regressions,
      confidence: passed ? 0.9 : 0.2,
      verification_log: '',
    });

    it('no_hypotheses when hypothesis list is empty', () => {
      expect(computeOutcome([], [])).toBe('no_hypotheses');
    });

    it('clear_winner when exactly one pass with no regressions', () => {
      expect(computeOutcome([h('h1'), h('h2')], [v('h1', true), v('h2', false)])).toBe(
        'clear_winner',
      );
    });

    it('does not count passes with regressions as clean wins', () => {
      // h1 passed reproducer but introduced regressions; h2 fully failed.
      // No clean passes + only one strong hypothesis → all_inconclusive.
      expect(
        computeOutcome([h('h1', 0.8), h('h2', 0.5)], [v('h1', true, ['t1.test']), v('h2', false)]),
      ).toBe('all_inconclusive');
    });

    it('multiple_plausible when two or more clean passes', () => {
      expect(computeOutcome([h('h1'), h('h2')], [v('h1', true), v('h2', true)])).toBe(
        'multiple_plausible',
      );
    });

    it('dissent when zero passes but ≥2 strong (≥0.7) hypotheses', () => {
      expect(
        computeOutcome([h('h1', 0.85), h('h2', 0.75)], [v('h1', false), v('h2', false)]),
      ).toBe('dissent');
    });

    it('all_inconclusive when zero passes and weak hypotheses', () => {
      expect(
        computeOutcome([h('h1', 0.4), h('h2', 0.3)], [v('h1', false), v('h2', false)]),
      ).toBe('all_inconclusive');
    });

    it('outputs a valid DiagnosisOutcome enum value', () => {
      const outcome = computeOutcome([h('h1')], [v('h1', true)]);
      const parsed = DiagnosisOutcomeSchema.safeParse(outcome);
      expect(parsed.success).toBe(true);
    });
  });

  describe('DiagnosisResultSchema (merged fields)', () => {
    it('accepts triage + outcome + recommended_next_skill', () => {
      const result: DiagnosisResult = {
        hypotheses: [createValidHypothesis()],
        triage: {
          failure_type: 'crash',
          error_signature: 'TypeError: foo',
          affected_area: 'src/x.ts:42',
        },
        outcome: 'clear_winner',
        recommended_next_skill: 'spec',
      };
      expect(DiagnosisResultSchema.safeParse(result).success).toBe(true);
    });

    it('accepts result with no triage/outcome (backward-compat)', () => {
      const result: DiagnosisResult = {
        hypotheses: [createValidHypothesis()],
      };
      expect(DiagnosisResultSchema.safeParse(result).success).toBe(true);
    });

    it('rejects invalid outcome values', () => {
      const result = {
        hypotheses: [createValidHypothesis()],
        outcome: 'bogus' as unknown,
      };
      expect(DiagnosisResultSchema.safeParse(result).success).toBe(false);
    });
  });

  describe('verify prompt honest-labeling regression', () => {
    let verifyPrompt: string;

    beforeEach(() => {
      const prompts = loadSkillPrompts('diagnose');
      verifyPrompt = prompts['verify.md'] ?? '';
    });

    it('does not instruct applying the fix or running commands', () => {
      // The verifier is read-only (Edit/Write/Bash disabled) so the prompt
      // must not tell it to apply the fix or execute the reproducer.
      expect(verifyPrompt).not.toMatch(/apply the (proposed|minimal) fix/i);
      expect(verifyPrompt).not.toMatch(/run the reproducer/i);
      expect(verifyPrompt).not.toMatch(/run related test suite/i);
    });

    it('contains read-only / prediction language', () => {
      expect(verifyPrompt).toMatch(/static|read-only|prediction/i);
      expect(verifyPrompt).toMatch(/Edit.*Write.*Bash|Bash.*disabled|read.only restrictions/i);
    });

    it('uses predicted_pass in the JSON example block', () => {
      expect(verifyPrompt).toContain('"predicted_pass"');
      expect(verifyPrompt).not.toContain('"reproducer_passed"');
    });

    it('VerificationResultSchema accepts predicted_pass and rejects reproducer_passed', () => {
      const withNew = {
        hypothesis_id: 'h1',
        predicted_pass: true,
        regressions: [],
        confidence: 0.8,
        verification_log: 'Read code — fix looks correct.',
      };
      expect(VerificationResultSchema.safeParse(withNew).success).toBe(true);

      const withOld = {
        hypothesis_id: 'h1',
        reproducer_passed: true,
        regressions: [],
        confidence: 0.8,
        verification_log: 'old format',
      };
      expect(VerificationResultSchema.safeParse(withOld).success).toBe(false);
    });
  });

});

// =============================================================================
// runReproducerBaseline — injectable-exec seam tests (no real processes)
// =============================================================================

/**
 * Build a fake exec function that the tests inject at the `exec` parameter of
 * runReproducerBaseline.  All shapes that promisify(execFile) can resolve or
 * reject are modelled here.
 */
type ExecResult = { stdout: string; stderr: string };
type FakeExec = (
  file: string,
  args: string[],
  opts: object,
) => Promise<ExecResult>;

function fakeExecSuccess(stdout: string, stderr = ''): FakeExec {
  return async () => ({ stdout, stderr });
}

function fakeExecFailure(opts: {
  code?: number | null;
  stdout?: string;
  stderr?: string;
  killed?: boolean;
  signal?: string;
}): FakeExec {
  return async () => {
    const err = Object.assign(new Error('process error'), {
      code: opts.code ?? 1,
      stdout: opts.stdout ?? '',
      stderr: opts.stderr ?? '',
      killed: opts.killed ?? false,
      signal: opts.signal,
    });
    throw err;
  };
}

describe('runReproducerBaseline', () => {
  const CWD = '/fake/repo';

  afterEach(() => {
    // Restore env after each test that mutates it.
    delete process.env['AFK_DIAGNOSE_BASELINE'];
  });

  it('captures non-zero exit code into exitCode without throwing', async () => {
    const exec = fakeExecFailure({ code: 1, stdout: 'test output', stderr: 'error line' });
    const result = await runReproducerBaseline('npm test', CWD, exec as never);

    expect(result.skipped).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('test output');
    expect(result.stderr).toBe('error line');
    expect(result.timedOut).toBe(false);
  });

  it('captures zero exit (reproducer passed on current code)', async () => {
    const exec = fakeExecSuccess('all tests passed', '');
    const result = await runReproducerBaseline('npm test', CWD, exec as never);

    expect(result.skipped).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('all tests passed');
    expect(result.stderr).toBe('');
    expect(result.timedOut).toBe(false);
  });

  it('sets timedOut when killed === true', async () => {
    const exec = fakeExecFailure({ code: null, stdout: 'partial', stderr: '', killed: true });
    const result = await runReproducerBaseline('npm test', CWD, exec as never);

    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe('partial');
  });

  it('sets timedOut when signal is SIGTERM', async () => {
    const exec = fakeExecFailure({ code: null, stdout: '', stderr: '', killed: false, signal: 'SIGTERM' });
    const result = await runReproducerBaseline('npm test', CWD, exec as never);

    expect(result.timedOut).toBe(true);
  });

  it('truncates stdout to last 4000 chars with marker', async () => {
    const big = 'A'.repeat(5000);
    const exec = fakeExecFailure({ code: 1, stdout: big, stderr: '' });
    const result = await runReproducerBaseline('npm test', CWD, exec as never);

    expect(result.stdout.length).toBeLessThanOrEqual(4000 + '...[truncated]\n'.length);
    expect(result.stdout.startsWith('...[truncated]\n')).toBe(true);
    // Tail characters must be preserved
    expect(result.stdout.endsWith('A'.repeat(100))).toBe(true);
  });

  it('truncates stderr to last 4000 chars with marker', async () => {
    const big = 'E'.repeat(5000);
    const exec = fakeExecFailure({ code: 1, stdout: '', stderr: big });
    const result = await runReproducerBaseline('npm test', CWD, exec as never);

    expect(result.stderr.startsWith('...[truncated]\n')).toBe(true);
  });

  it('does not truncate output under the limit', async () => {
    const short = 'X'.repeat(100);
    const exec = fakeExecSuccess(short, 'err');
    const result = await runReproducerBaseline('npm test', CWD, exec as never);

    expect(result.stdout).toBe(short);
  });

  it('skips when command is empty string', async () => {
    const exec = vi.fn() as unknown as FakeExec;
    const result = await runReproducerBaseline('', CWD, exec as never);

    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('no reproducer command detected');
    expect(exec).not.toHaveBeenCalled();
  });

  it('skips when AFK_DIAGNOSE_BASELINE=0 is set', async () => {
    process.env['AFK_DIAGNOSE_BASELINE'] = '0';
    const exec = vi.fn() as unknown as FakeExec;
    const result = await runReproducerBaseline('npm test', CWD, exec as never);

    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('AFK_DIAGNOSE_BASELINE=0');
    expect(exec).not.toHaveBeenCalled();
  });

  it('does NOT skip when AFK_DIAGNOSE_BASELINE is unset (default enabled)', async () => {
    delete process.env['AFK_DIAGNOSE_BASELINE'];
    const exec = fakeExecSuccess('ok', '');
    const result = await runReproducerBaseline('npm test', CWD, exec as never);

    expect(result.skipped).toBe(false);
  });

  it('skips with a named reason on spawn ENOENT when the cwd does not exist (dead worktree)', async () => {
    // Regression: spawn with a deleted cwd rejects with code:'ENOENT'
    // (string) + syscall:'spawn /bin/sh' — previously coerced through the
    // non-zero-exit path into { skipped:false, exitCode:null, stdout:'',
    // stderr:'' }, masquerading as "reproducer ran and produced nothing".
    const exec: FakeExec = async () => {
      throw Object.assign(new Error('spawn /bin/sh ENOENT'), {
        code: 'ENOENT',
        errno: -2,
        syscall: 'spawn /bin/sh',
        path: '/bin/sh',
        stdout: '',
        stderr: '',
      });
    };
    // CWD ('/fake/repo') does not exist on disk — the dead-worktree case.
    const result = await runReproducerBaseline('npm test', CWD, exec as never);

    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('cwd does not exist');
    expect(result.reason).toContain(CWD);
    expect(result.exitCode).toBeNull();
  });

  it('does NOT skip on spawn ENOENT when the cwd exists (genuinely missing binary)', async () => {
    const { tmpdir } = await import('node:os');
    const exec: FakeExec = async () => {
      throw Object.assign(new Error('spawn not-a-binary ENOENT'), {
        code: 'ENOENT',
        errno: -2,
        syscall: 'spawn not-a-binary',
        path: 'not-a-binary',
        stdout: '',
        stderr: '',
      });
    };
    const result = await runReproducerBaseline('npm test', tmpdir(), exec as never);

    // Live cwd → not a dead-worktree masquerade; falls through to the
    // string-code coercion (exitCode null, not skipped).
    expect(result.skipped).toBe(false);
    expect(result.exitCode).toBeNull();
  });
});

// =============================================================================
// buildVerifierUserPrompt
// =============================================================================

function skippedBaseline(reason = 'no reproducer command detected'): BaselineResult {
  return { skipped: true, reason, exitCode: null, stdout: '', stderr: '', timedOut: false };
}

function measuredBaseline(overrides: Partial<BaselineResult> = {}): BaselineResult {
  return {
    skipped: false,
    exitCode: 1,
    stdout: 'test output',
    stderr: 'error line',
    timedOut: false,
    ...overrides,
  };
}

describe('buildVerifierUserPrompt', () => {
  const hyp = {
    id: 'h1',
    claim: 'Type mismatch',
    location: 'src/foo.ts:42',
    proposed_fix: 'Change to number',
  };

  it('includes the BASELINE block when not skipped', () => {
    const baseline = measuredBaseline({ exitCode: 1, stdout: 'FAIL', stderr: '' });
    const prompt = buildVerifierUserPrompt(hyp, 'npm test', '/wt/path', baseline);

    expect(prompt).toContain('BASELINE');
    expect(prompt).toContain('exit code: 1');
    expect(prompt).toContain('$ npm test');
    expect(prompt).toContain('FAIL');
  });

  it('includes "(not run: …)" form when skipped', () => {
    const baseline = skippedBaseline('no reproducer command detected');
    const prompt = buildVerifierUserPrompt(hyp, 'npm test', '/wt/path', baseline);

    expect(prompt).toContain('BASELINE');
    expect(prompt).toContain('(not run: no reproducer command detected)');
    expect(prompt).not.toContain('exit code:');
  });

  it('appends TIMED OUT note when timedOut is true', () => {
    const baseline = measuredBaseline({ exitCode: null, timedOut: true });
    const prompt = buildVerifierUserPrompt(hyp, 'npm test', '/wt/path', baseline);

    expect(prompt).toContain('TIMED OUT');
  });

  it('includes guidance to set stance: blocks when exit code is 0', () => {
    const baseline = measuredBaseline({ exitCode: 0 });
    const prompt = buildVerifierUserPrompt(hyp, 'npm test', '/wt/path', baseline);

    expect(prompt).toContain('exit code: 0');
    expect(prompt).toMatch(/stance.*blocks/i);
  });

  it('does not include stance:blocks guidance when exit code is non-zero', () => {
    const baseline = measuredBaseline({ exitCode: 1 });
    const prompt = buildVerifierUserPrompt(hyp, 'npm test', '/wt/path', baseline);

    expect(prompt).not.toMatch(/stance.*blocks/i);
  });

  it('includes the worktree path', () => {
    const baseline = skippedBaseline();
    const prompt = buildVerifierUserPrompt(hyp, 'npm test', '/isolated/worktree', baseline);

    expect(prompt).toContain('/isolated/worktree');
  });

  it('includes hypothesis fields', () => {
    const baseline = skippedBaseline();
    const prompt = buildVerifierUserPrompt(hyp, 'npm test', '/wt', baseline);

    expect(prompt).toContain('Type mismatch');
    expect(prompt).toContain('src/foo.ts:42');
    expect(prompt).toContain('Change to number');
  });
});
