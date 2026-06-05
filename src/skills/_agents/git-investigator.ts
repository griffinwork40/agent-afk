import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const gitInvestigator = {
  name: 'git-investigator' as const,
  systemPrompt: readFileSync(join(__dirname, 'prompts/git-investigator.md'), 'utf8'),
  sourcePath: 'vendored/git-investigator.md',
  allowedTools: ['Bash', 'Read', 'Grep', 'Glob'] as const,
  description:
    'Read-only git specialist. Dispatched by research-agent (or any research-shaped caller) when a finding requires git history, reflog, diff, blame, branch/remote state, or merge-base analysis. Runs git commands only — no mutations, no shell escapes.',
  model: 'sonnet' as const,
};
