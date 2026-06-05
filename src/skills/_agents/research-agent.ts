import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const researchAgent = {
  name: 'research-agent' as const,
  systemPrompt: readFileSync(join(__dirname, 'prompts/research-agent.md'), 'utf8'),
  sourcePath: 'vendored/research-agent.md',
  // Read-only base — used by leaf research dispatches across multiple skills.
  // The orchestrator role that adds Agent for nested git-investigator dispatch
  // is diagnose-local; see createGitOrchestratorCanUseTool there. The vendored
  // prompt (byte-equal with upstream) mentions Agent dispatch; in skills that
  // don't supply an `agents` registry the model falls back to `scope_check`.
  allowedTools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'] as const,
  description:
    'Read-only sub-agent for research, validation, verification, and codebase inspection. Mechanically locked to Read, Grep, Glob, WebFetch, WebSearch — cannot Edit, Write, Bash, commit, or push. Delegates git queries to `git-investigator`. Use when the dispatched task is findings-only.',
};
