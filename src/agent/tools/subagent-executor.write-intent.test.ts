/**
 * Tests for collectPostRunWarnings — the post-run warning helper extracted
 * from SubagentExecutor for issue #944.
 */

import { describe, it, expect } from 'vitest';
import { collectPostRunWarnings } from './subagent-executor.write-intent.js';

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
