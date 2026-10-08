/**
 * Structural tests for `.github/actions/run-afk/action.yml`.
 *
 * These run inside `pnpm test` on every PR so shape regressions in the
 * composite action are caught locally before CI, without needing a YAML
 * library or network access.  Parsing is intentionally lightweight — the
 * goal is to guard required metadata fields and security invariants, not to
 * exercise full YAML semantics.
 */

import { describe, expect, it } from 'vitest';

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const actionPath = join(repoRoot, '.github', 'actions', 'run-afk', 'action.yml');
const validationWorkflowPath = join(
  repoRoot,
  '.github',
  'workflows',
  'validate-action.yml',
);

/**
 * Read the action.yml as text, normalizing CRLF line endings so that regex
 * tests using \n anchors pass on Windows checkouts.
 */
function readAction(): string {
  return readFileSync(actionPath, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * Read the validation workflow as text, normalizing CRLF line endings so that
 * regex tests using \n anchors pass on Windows checkouts.
 */
function readValidationWorkflow(): string {
  return readFileSync(validationWorkflowPath, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * Extract all `run:` block bodies from a composite action YAML source.
 *
 * A run block starts with a line matching /^\s+run:\s*(|)$/ and continues
 * with lines that are more deeply indented than the `run:` line itself (or
 * blank lines within the block).  Returns each block body as a single string.
 */
function extractRunBlocks(src: string): string[] {
  const lines = src.split('\n');
  const blocks: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // Match a `run:` key at any indentation level (composite action steps).
    // Single-line form (`run: npm install ...`) is an injection vector too.
    const inlineMatch = /^\s+run:\s*([^|>\s].*)$/.exec(line);
    if (inlineMatch) {
      blocks.push(inlineMatch[1]!);
      i++;
      continue;
    }
    const runMatch = /^(\s+)run:\s*[|>]?\s*$/.exec(line);
    if (runMatch) {
      const baseIndent = runMatch[1]!.length;
      const bodyLines: string[] = [];
      i++;
      // Collect continuation lines: more indented than `run:`, or blank.
      while (i < lines.length) {
        const bodyLine = lines[i]!;
        if (bodyLine.trim() === '') {
          bodyLines.push(bodyLine);
          i++;
          continue;
        }
        const bodyIndent = bodyLine.match(/^(\s*)/)?.[1]?.length ?? 0;
        if (bodyIndent > baseIndent) {
          bodyLines.push(bodyLine);
          i++;
        } else {
          break;
        }
      }
      if (bodyLines.length > 0) {
        blocks.push(bodyLines.join('\n'));
      }
    } else {
      i++;
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// File existence
// ---------------------------------------------------------------------------

describe('run-afk action — file presence', () => {
  it('action.yml exists', () => {
    expect(existsSync(actionPath)).toBe(true);
  });

  it('validate-action.yml workflow exists', () => {
    expect(existsSync(validationWorkflowPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// action.yml structural checks
// ---------------------------------------------------------------------------

describe('run-afk action — action.yml structure', () => {
  it('declares composite as the runner', () => {
    const src = readAction();
    expect(src).toMatch(/using:\s*composite/);
  });

  it('has a non-empty name', () => {
    const src = readAction();
    const match = /^name:\s*(.+)/m.exec(src);
    expect(match).not.toBeNull();
    expect(match![1]!.trim().length).toBeGreaterThan(0);
  });

  it('has a non-empty description', () => {
    const src = readAction();
    expect(src).toMatch(/^description:/m);
  });

  it('declares the anthropic-api-key input as required', () => {
    const src = readAction();
    // Extract the block between `  anthropic-api-key:` and the next
    // same-level key (another `  <name>:` line).  Each line of a YAML
    // mapping value at this nesting level starts with at least 4 spaces, so
    // a line starting with exactly 2 spaces (and a non-space) begins the
    // next sibling key.
    const blockRe = /^  anthropic-api-key:((?:\n(?:    .*|\s*))*)/m;
    const match = blockRe.exec(src);
    expect(match).not.toBeNull();
    expect(match![0]).toMatch(/required:\s*true/);
  });

  it('declares the prompt input as required', () => {
    const src = readAction();
    const blockRe = /^  prompt:((?:\n(?:    .*|\s*))*)/m;
    const match = blockRe.exec(src);
    expect(match).not.toBeNull();
    expect(match![0]).toMatch(/required:\s*true/);
  });

  it('exposes a response output', () => {
    const src = readAction();
    expect(src).toMatch(/^outputs:/m);
    expect(src).toMatch(/response:/);
  });

  // Security invariants -------------------------------------------------------

  it('does not hard-code any API key or secret value', () => {
    const src = readAction();
    // Must not contain raw bearer-token-shaped strings.
    expect(src).not.toMatch(/sk-ant-[A-Za-z0-9-]+/);
    expect(src).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
  });

  it('maps anthropic-api-key to ANTHROPIC_API_KEY env var, not a shell arg', () => {
    const src = readAction();
    // The key must appear in an `env:` block, not directly in `run:` args.
    expect(src).toMatch(/ANTHROPIC_API_KEY:\s*\$\{\{\s*inputs\.anthropic-api-key\s*\}\}/);
  });

  it('pins third-party actions to full commit SHAs (no bare tag references)', () => {
    const src = readAction();
    // Extract every `uses:` line and assert each one has a 40-char hex SHA.
    const usesLines = src
      .split('\n')
      .filter((line) => /uses:/.test(line))
      .map((line) => line.trim());

    expect(usesLines.length).toBeGreaterThan(0);

    for (const line of usesLines) {
      // A SHA-pinned reference looks like: owner/repo@<40 hex chars>
      expect(line).toMatch(
        /@[0-9a-f]{40}\b/,
        `Action reference is not pinned to a full SHA: ${line}`,
      );
    }
  });

  it('sets AFK_NO_TUI to suppress interactive chrome in CI', () => {
    const src = readAction();
    expect(src).toMatch(/AFK_NO_TUI/);
  });

  // Injection-safety invariants -----------------------------------------------

  it('has no ${{ inputs.* }} expressions inside any run: block', () => {
    const src = readAction();
    const runBlocks = extractRunBlocks(src);
    expect(runBlocks.length).toBeGreaterThan(0);
    for (const block of runBlocks) {
      // ${{ inputs.<anything> }} inside a run: body is a script injection vector.
      expect(block).not.toMatch(
        /\$\{\{\s*inputs\./,
        `Found $\{{ inputs.* }} inside a run: block — route it through env: instead:\n${block}`,
      );
    }
  });

  it('uses --format json when invoking afk chat', () => {
    const src = readAction();
    const runBlocks = extractRunBlocks(src);
    // At least one run block must contain the --format json flag.
    const hasFormatJson = runBlocks.some((b) => /--format\s+json/.test(b));
    expect(hasFormatJson).toBe(
      true,
      'No run block calls afk chat with --format json. ' +
        'The action must use JSON output mode to capture a clean response.',
    );
  });

  it('uses a generated random delimiter for GITHUB_OUTPUT, not the fixed literal __AFK_EOF__', () => {
    const src = readAction();
    const runBlocks = extractRunBlocks(src);
    // The fixed literal __AFK_EOF__ must not appear in any run block.
    for (const block of runBlocks) {
      expect(block).not.toMatch(
        /__AFK_EOF__/,
        'Found the fixed literal __AFK_EOF__ as a GITHUB_OUTPUT delimiter. ' +
          'Use a generated random delimiter (e.g. AFK_EOF_$(openssl rand -hex 16)) ' +
          'to prevent delimiter collision attacks.',
      );
    }
    // At least one run block must contain a dynamically generated delimiter.
    const hasGeneratedDelim = runBlocks.some(
      (b) => /delim\s*=/.test(b) || /AFK_EOF_\$/.test(b),
    );
    expect(hasGeneratedDelim).toBe(
      true,
      'No run block generates a random GITHUB_OUTPUT delimiter. ' +
        'Use e.g. delim="AFK_EOF_$(openssl rand -hex 16 ...)" to avoid collision.',
    );
  });
});

// ---------------------------------------------------------------------------
// validate-action.yml workflow checks
// ---------------------------------------------------------------------------

describe('validate-action.yml workflow', () => {
  it('pins its checkout action to a full SHA', () => {
    const src = readValidationWorkflow();
    const usesLines = src
      .split('\n')
      .filter((line) => /uses:/.test(line))
      .map((line) => line.trim());

    for (const line of usesLines) {
      expect(line).toMatch(
        /@[0-9a-f]{40}\b/,
        `Workflow action reference is not SHA-pinned: ${line}`,
      );
    }
  });

  it('runs on changes to the action directory', () => {
    const src = readValidationWorkflow();
    expect(src).toMatch(/\.github\/actions\/run-afk/);
  });

  it('invokes the vitest test file', () => {
    const src = readValidationWorkflow();
    expect(src).toMatch(/github-action\.test\.ts/);
  });
});
