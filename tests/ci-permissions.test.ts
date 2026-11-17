import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('read-only CI workflow token permissions (#4926)', () => {
  it.each(['ci.yml', 'validate-action.yml'])('%s explicitly limits the token to contents: read', (name) => {
    const workflow = readFileSync(join(root, '.github', 'workflows', name), 'utf8')
      .replace(/\r\n/g, '\n');
    const permissions = /^permissions:\n((?:[ \t]+[^\n]*\n|\n)*)/m.exec(workflow)?.[1];

    expect(permissions?.trim()).toBe('contents: read');
    // These jobs only checkout/build/test; no job needs a broader token scope.
    expect(workflow).not.toMatch(/^[ \t]+permissions:/m);
  });
});
