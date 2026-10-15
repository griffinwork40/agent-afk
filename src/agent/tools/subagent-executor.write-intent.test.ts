/**
 * Tests for collectPostRunWarnings and classifyDispatchIntent — helpers
 * extracted from SubagentExecutor (issues #944, #3754).
 */

import { describe, it, expect } from 'vitest';
import { collectPostRunWarnings, classifyDispatchIntent } from './subagent-executor.write-intent.js';

const noVision = (_m: string) => false;
const hasVision = (_m: string) => true;

describe('collectPostRunWarnings', () => {
  describe('vision warning', () => {
    it('emits a warning when attachments are present and model lacks vision', () => {
      const warn = collectPostRunWarnings('claude-haiku', true, undefined, 'investigate', true, noVision);
      expect(warn).toContain('not vision-capable');
      expect(warn).toContain('claude-haiku');
    });

    it('emits no vision warning when the model supports vision', () => {
      const warn = collectPostRunWarnings('claude-sonnet', true, undefined, 'investigate', true, hasVision);
      expect(warn).not.toContain('not vision-capable');
    });

    it('emits no vision warning when there are no attachments', () => {
      const warn = collectPostRunWarnings('claude-haiku', false, undefined, 'investigate', true, noVision);
      expect(warn).not.toContain('not vision-capable');
    });
  });

  describe('read-only write-intent warning', () => {
    it('warns when a non-write-capable named agent has write intent in the prompt', () => {
      const warn = collectPostRunWarnings(
        'claude-haiku',
        false,
        'research-agent',
        'Please write a report to findings.md',
        false, // not write-capable
        hasVision,
      );
      expect(warn).toContain('research-agent');
      expect(warn).toContain('read-only');
    });

    it('does not warn when the agent is write-capable', () => {
      const warn = collectPostRunWarnings(
        'claude-haiku',
        false,
        'general-purpose',
        'Please write a report to findings.md',
        true, // write-capable
        hasVision,
      );
      expect(warn).not.toContain('read-only');
    });

    it('does not warn when no agent name is provided (bare dispatch)', () => {
      const warn = collectPostRunWarnings(
        'claude-haiku',
        false,
        undefined, // no named agent
        'Please save a file',
        false,
        hasVision,
      );
      expect(warn).not.toContain('read-only');
    });

    it('does not warn when the prompt contains no write intent', () => {
      const warn = collectPostRunWarnings(
        'claude-haiku',
        false,
        'research-agent',
        'Investigate the codebase and return findings',
        false,
        hasVision,
      );
      expect(warn).toBe('');
    });

    it('detects write intent with various verb+noun patterns', () => {
      const writePrompts = [
        'save a report to disk',
        'persist a file with findings',
        'generate a document with the findings',
        'write a markdown file summarising results',
        'create a doc of your analysis',
      ];
      for (const prompt of writePrompts) {
        const warn = collectPostRunWarnings('m', false, 'research-agent', prompt, false, hasVision);
        expect(warn, `expected warning for: "${prompt}"`).toContain('read-only');
      }
    });

    it('detects write intent when a filename with extension is named directly', () => {
      const writePrompts = [
        'write findings.md',
        'write F-rubric-audit.md',
        'save results.json to disk',
        'output report.txt',
        'create analysis.ts',
        'generate summary.yaml',
      ];
      for (const prompt of writePrompts) {
        const warn = collectPostRunWarnings('m', false, 'research-agent', prompt, false, hasVision);
        expect(warn, `expected warning for: "${prompt}"`).toContain('read-only');
      }
    });

    it('warning message points callers to the message below, not above', () => {
      const warn = collectPostRunWarnings(
        'claude-haiku',
        false,
        'research-agent',
        'write findings.md',
        false,
        hasVision,
      );
      expect(warn).toContain('below');
      expect(warn).not.toContain('above');
    });

    it('does not false-positive on "output" as a generic noun', () => {
      const safePrompts = [
        'generate output for the console',
        'create output from the analysis',
        'produce output summarising the findings',
      ];
      for (const prompt of safePrompts) {
        const warn = collectPostRunWarnings('m', false, 'research-agent', prompt, false, hasVision);
        expect(warn, `unexpected warning for: "${prompt}"`).toBe('');
      }
    });

    it('does not trigger on non-matching phrases', () => {
      const safePrompts = [
        'Analyse the codebase thoroughly',
        'Read the config and describe it',
        'List all exported functions',
      ];
      for (const prompt of safePrompts) {
        const warn = collectPostRunWarnings('m', false, 'research-agent', prompt, false, hasVision);
        expect(warn, `unexpected warning for: "${prompt}"`).toBe('');
      }
    });
  });

  describe('caller-level isError guard', () => {
    it('warning is non-empty even on error-destined results — caller must gate on isError', () => {
      // collectPostRunWarnings is a pure function that does not know whether the
      // child succeeded or failed. The caller (subagent-executor.ts) must gate
      // on `!result.isError` before prepending. This test documents the contract:
      // the function returns a non-empty warning when conditions match, and it is
      // the caller's responsibility to suppress it on error results.
      const warn = collectPostRunWarnings(
        'claude-haiku',
        false,
        'research-agent',
        'write findings.md',
        false,
        hasVision,
      );
      expect(warn).not.toBe('');
      // Simulated caller-side guard:
      const errorResult = { content: '{"error":"timeout"}', isError: true };
      if (warn && !errorResult.isError) {
        errorResult.content = warn + errorResult.content;
      }
      // Content must remain unchanged when isError is true
      expect(errorResult.content).toBe('{"error":"timeout"}');
    });
  });

  describe('both warnings combined', () => {
    it('emits both warnings when both conditions apply', () => {
      const warn = collectPostRunWarnings(
        'claude-haiku',
        true, // attachments
        'research-agent',
        'save a file with the results',
        false, // not write-capable
        noVision,
      );
      expect(warn).toContain('not vision-capable');
      expect(warn).toContain('read-only');
    });

    it('returns empty string when no warnings apply', () => {
      const warn = collectPostRunWarnings(
        'claude-sonnet',
        false,
        undefined,
        'just look around',
        true,
        hasVision,
      );
      expect(warn).toBe('');
    });
  });
});

describe('classifyDispatchIntent (#3754)', () => {
  describe('true positives — implementation briefs that must be rejected', () => {
    it('detects "edit src/foo.ts to fix the bug"', () => {
      expect(classifyDispatchIntent('edit src/foo.ts to fix the bug')).toBe(true);
    });

    it('detects "apply the patch to the codebase"', () => {
      expect(classifyDispatchIntent('apply the patch to the codebase')).toBe(true);
    });

    it('detects "implement the feature in the module"', () => {
      expect(classifyDispatchIntent('implement the feature in the module')).toBe(true);
    });

    it('detects "fix the bug in auth.ts"', () => {
      expect(classifyDispatchIntent('fix the bug in auth.ts')).toBe(true);
    });

    it('detects "refactor the module to use the new API"', () => {
      expect(classifyDispatchIntent('refactor the module to use the new API')).toBe(true);
    });

    it('detects "commit the changes to main"', () => {
      expect(classifyDispatchIntent('commit the changes to main')).toBe(true);
    });

    it('detects "push to main branch"', () => {
      expect(classifyDispatchIntent('push to main branch')).toBe(true);
    });

    it('detects "use edit_file to update the config"', () => {
      expect(classifyDispatchIntent('use edit_file to update the config')).toBe(true);
    });

    it('detects "call write_file with the new content"', () => {
      expect(classifyDispatchIntent('call write_file with the new content')).toBe(true);
    });

    it('detects "update config.ts with the new settings"', () => {
      expect(classifyDispatchIntent('update config.ts with the new settings')).toBe(true);
    });

    it('detects "write the implementation to disk"', () => {
      expect(classifyDispatchIntent('write the implementation to disk')).toBe(true);
    });
  });

  describe('false positives — recon briefs that must NOT be rejected', () => {
    it('passes "do not edit files, only report findings"', () => {
      expect(classifyDispatchIntent('do not edit files, only report findings')).toBe(false);
    });

    it('passes "report what should be changed in the codebase"', () => {
      expect(classifyDispatchIntent('report what should be changed in the codebase')).toBe(false);
    });

    it('passes "identify which files need updating"', () => {
      expect(classifyDispatchIntent('identify which files need updating')).toBe(false);
    });

    it('passes "describe edits needed without making them"', () => {
      expect(classifyDispatchIntent('describe edits needed without making them')).toBe(false);
    });

    it('passes "find where the bug is but do not fix it"', () => {
      expect(classifyDispatchIntent('find where the bug is but do not fix it')).toBe(false);
    });

    it('passes "research the codebase and return findings"', () => {
      expect(classifyDispatchIntent('research the codebase and return findings')).toBe(false);
    });

    it('passes "check if edit_file was called anywhere in the session"', () => {
      expect(classifyDispatchIntent('check if edit_file was called anywhere in the session')).toBe(false);
    });

    it('passes "analyse the module and describe what should change"', () => {
      expect(classifyDispatchIntent('analyse the module and describe what should change')).toBe(false);
    });

    it('passes empty string', () => {
      expect(classifyDispatchIntent('')).toBe(false);
    });

    it('passes pure recon: "grep for TODO comments across the repo"', () => {
      expect(classifyDispatchIntent('grep for TODO comments across the repo')).toBe(false);
    });

    it('passes "list files that need to be updated"', () => {
      expect(classifyDispatchIntent('list files that need to be updated')).toBe(false);
    });

    it('passes "never modify the files, just audit them"', () => {
      expect(classifyDispatchIntent('never modify the files, just audit them')).toBe(false);
    });
  });
});
