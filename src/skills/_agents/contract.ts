import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const contract = {
  name: 'contract' as const,
  systemPrompt: readFileSync(join(__dirname, 'prompts/contract.md'), 'utf8'),
  sourcePath: 'vendored/contract.md',
};

// Notify prompt registry of loaded content
import('../../prompts/registry.js').then(
  (m) => m.notifyPromptLoaded(),
  () => { /* registry not available — ok during build */ },
).catch(() => {});
