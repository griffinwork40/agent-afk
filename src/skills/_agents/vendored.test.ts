import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Pinned hashes — guard against undocumented edits to the vendored copy
const PINNED_HASHES = {
  'research-agent': '141b2859797bd538f01293b5570643b5757cb7a96438cc9be0d97106e3eb92bd',
  contract: '0b7febafec024e8dd4404f75e84d21ee72b1b1846d6e2610aaa82ba77f9d6f2d',
  'git-investigator': 'c31560bdb80d84c42f25938facdb883aa8120df2e6ec1d341bfb61bfac4769da',
} as const;

type AgentName = keyof typeof PINNED_HASHES;

function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function readPrompt(name: AgentName): string {
  const promptPath = join(
    __dirname,
    '../../../src/skills/_agents/prompts',
    `${name}.md`
  );
  return readFileSync(promptPath, 'utf8');
}

describe('vendored agents', () => {
  describe('byte-equal snapshot tests', () => {
    it('research-agent prompt matches pinned hash', () => {
      const content = readPrompt('research-agent');
      const hash = computeHash(content);
      expect(hash).toBe(PINNED_HASHES['research-agent']);
    });

    it('contract prompt matches pinned hash', () => {
      const content = readPrompt('contract');
      const hash = computeHash(content);
      expect(hash).toBe(PINNED_HASHES.contract);
    });

    it('git-investigator prompt matches pinned hash', () => {
      const content = readPrompt('git-investigator');
      const hash = computeHash(content);
      expect(hash).toBe(PINNED_HASHES['git-investigator']);
    });
  });

  describe('research-agent tool allowlist', () => {
    it('includes Read in allowedTools', async () => {
      const { researchAgent } = await import(
        './index.js'
      );
      expect(researchAgent.allowedTools).toContain('Read');
    });

    it('excludes Edit from allowedTools', async () => {
      const { researchAgent } = await import(
        './index.js'
      );
      expect(researchAgent.allowedTools).not.toContain('Edit');
    });

    it('excludes Write from allowedTools', async () => {
      const { researchAgent } = await import(
        './index.js'
      );
      expect(researchAgent.allowedTools).not.toContain('Write');
    });

    it('excludes Bash from allowedTools', async () => {
      const { researchAgent } = await import(
        './index.js'
      );
      expect(researchAgent.allowedTools).not.toContain('Bash');
    });

    it('excludes Agent from allowedTools (orchestrator role is diagnose-local)', async () => {
      const { researchAgent } = await import(
        './index.js'
      );
      expect(researchAgent.allowedTools).not.toContain('Agent');
    });

    it('contains exactly the allowed tools', async () => {
      const { researchAgent } = await import(
        './index.js'
      );
      const expected = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];
      expect(new Set(researchAgent.allowedTools)).toEqual(new Set(expected));
    });
  });

  describe('git-investigator tool allowlist', () => {
    it('includes Bash in allowedTools', async () => {
      const { gitInvestigator } = await import(
        './index.js'
      );
      expect(gitInvestigator.allowedTools).toContain('Bash');
    });

    it('excludes Edit from allowedTools', async () => {
      const { gitInvestigator } = await import(
        './index.js'
      );
      expect(gitInvestigator.allowedTools).not.toContain('Edit');
    });

    it('excludes Write from allowedTools', async () => {
      const { gitInvestigator } = await import(
        './index.js'
      );
      expect(gitInvestigator.allowedTools).not.toContain('Write');
    });

    it('excludes Agent from allowedTools (leaf agent)', async () => {
      const { gitInvestigator } = await import(
        './index.js'
      );
      expect(gitInvestigator.allowedTools).not.toContain('Agent');
    });

    it('contains exactly the allowed tools', async () => {
      const { gitInvestigator } = await import(
        './index.js'
      );
      const expected = ['Bash', 'Read', 'Grep', 'Glob'];
      expect(new Set(gitInvestigator.allowedTools)).toEqual(new Set(expected));
    });
  });

  describe('barrel exports', () => {
    it('exports researchAgent with name and systemPrompt', async () => {
      const { researchAgent } = await import(
        './index.js'
      );
      expect(researchAgent).toBeDefined();
      expect(researchAgent.name).toBe('research-agent');
      expect(typeof researchAgent.systemPrompt).toBe('string');
      expect(researchAgent.systemPrompt.length).toBeGreaterThan(0);
    });

    it('exports contract with name and systemPrompt', async () => {
      const { contract } = await import(
        './index.js'
      );
      expect(contract).toBeDefined();
      expect(contract.name).toBe('contract');
      expect(typeof contract.systemPrompt).toBe('string');
      expect(contract.systemPrompt.length).toBeGreaterThan(0);
    });

    it('researchAgent has sourcePath for drift audit', async () => {
      const { researchAgent } = await import(
        './index.js'
      );
      expect(researchAgent.sourcePath).toBe('vendored/research-agent.md');
    });

    it('contract has sourcePath for drift audit', async () => {
      const { contract } = await import(
        './index.js'
      );
      expect(contract.sourcePath).toBe('vendored/contract.md');
    });

    it('exports gitInvestigator with name and systemPrompt', async () => {
      const { gitInvestigator } = await import(
        './index.js'
      );
      expect(gitInvestigator).toBeDefined();
      expect(gitInvestigator.name).toBe('git-investigator');
      expect(typeof gitInvestigator.systemPrompt).toBe('string');
      expect(gitInvestigator.systemPrompt.length).toBeGreaterThan(0);
    });

    it('gitInvestigator has sourcePath for drift audit', async () => {
      const { gitInvestigator } = await import(
        './index.js'
      );
      expect(gitInvestigator.sourcePath).toBe('vendored/git-investigator.md');
    });
  });
});
