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

  it('declares the anthropic-api-key input as optional (required: false)', () => {
    const src = readAction();
    // Extract the block between `  anthropic-api-key:` and the next
    // same-level key (another `  <name>:` line).  Each line of a YAML
    // mapping value at this nesting level starts with at least 4 spaces, so
    // a line starting with exactly 2 spaces (and a non-space) begins the
    // next sibling key.
    const blockRe = /^  anthropic-api-key:((?:\n(?:    .*|\s*))*)/m;
    const match = blockRe.exec(src);
    expect(match).not.toBeNull();
    // F1: anthropic-api-key is now optional; at least one provider key required.
    expect(match![0]).toMatch(/required:\s*false/);
    expect(match![0]).toMatch(/default:\s*''/);
  });

  it('declares openai-api-key as optional with an empty default', () => {
    const src = readAction();
    const blockRe = /^  openai-api-key:((?:\n(?:    .*|\s*))*)/m;
    const match = blockRe.exec(src);
    expect(match).not.toBeNull();
    expect(match![0]).toMatch(/required:\s*false/);
    expect(match![0]).toMatch(/default:\s*''/);
  });

  it('declares xai-api-key as optional with an empty default', () => {
    const src = readAction();
    const blockRe = /^  xai-api-key:((?:\n(?:    .*|\s*))*)/m;
    const match = blockRe.exec(src);
    expect(match).not.toBeNull();
    expect(match![0]).toMatch(/required:\s*false/);
    expect(match![0]).toMatch(/default:\s*''/);
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

  it('maps anthropic-api-key to INPUT_ANTHROPIC_API_KEY in the step env: block (not the canonical name)', () => {
    const src = readAction();
    // Contract: the step env: block must map the input to the INPUT_* name.
    // Mapping directly to ANTHROPIC_API_KEY would overwrite any inherited env value.
    expect(src).toMatch(/INPUT_ANTHROPIC_API_KEY:\s*\$\{\{\s*inputs\.anthropic-api-key\s*\}\}/);
  });

  it('does not assign any canonical key name from an input in the step env: block', () => {
    const src = readAction();
    // Contract: ANTHROPIC_API_KEY, OPENAI_API_KEY, XAI_API_KEY must NOT appear
    // as env: assignments (lines starting with whitespace then the key name and
    // a colon) that reference ${{ inputs.* }}. Those assignments would silently
    // replace an inherited env value with the empty input default.
    // The regex anchors to the start of a line with leading whitespace so it
    // does not false-match the canonical name appearing inside a description
    // string like "Anthropic API key (ANTHROPIC_API_KEY)".
    expect(src).not.toMatch(/^\s+ANTHROPIC_API_KEY:\s*\$\{\{\s*inputs\./m);
    expect(src).not.toMatch(/^\s+OPENAI_API_KEY:\s*\$\{\{\s*inputs\./m);
    expect(src).not.toMatch(/^\s+XAI_API_KEY:\s*\$\{\{\s*inputs\./m);
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

  it('declares openai-api-key input', () => {
    const src = readAction();
    expect(src).toMatch(/openai-api-key:/);
  });

  it('declares xai-api-key input', () => {
    const src = readAction();
    expect(src).toMatch(/xai-api-key:/);
  });

  it('maps openai-api-key to INPUT_OPENAI_API_KEY in the step env: block', () => {
    const src = readAction();
    expect(src).toMatch(/INPUT_OPENAI_API_KEY:\s*\$\{\{\s*inputs\.openai-api-key\s*\}\}/);
  });

  it('maps xai-api-key to INPUT_XAI_API_KEY in the step env: block', () => {
    const src = readAction();
    expect(src).toMatch(/INPUT_XAI_API_KEY:\s*\$\{\{\s*inputs\.xai-api-key\s*\}\}/);
  });

  it('pins pnpm to version 11, not "latest"', () => {
    const src = readAction();
    // The pnpm setup step must use an explicit major version, not "latest".
    // "latest" is non-deterministic and can silently break on major bumps.
    const pnpmSetupBlock = src.match(
      /Setup pnpm[\s\S]*?(?=\n    - name:|\n\s*runs:|$)/,
    )?.[0] ?? '';
    // Must contain exactly `version: 11` (major-pinned; not 12+ by accident).
    expect(pnpmSetupBlock).toMatch(/version:\s*11\b/);
    // Must NOT contain `version: latest`.
    expect(pnpmSetupBlock).not.toMatch(/version:\s*latest/);
  });

  it('all-keys-empty guard exists in run script', () => {
    const src = readAction();
    const runBlocks = extractRunBlocks(src);
    // F1: the main run block must contain the guard that rejects a call where
    // all three provider keys are empty.
    const hasGuard = runBlocks.some((b) =>
      /At least one of/.test(b) &&
      /anthropic-api-key/.test(b) &&
      /openai-api-key/.test(b) &&
      /xai-api-key/.test(b),
    );
    expect(hasGuard).toBe(
      true,
      'No run block contains the all-keys-empty guard. ' +
        'The action must emit ::error:: and exit 1 when all three provider keys are empty.',
    );
  });

  it('run script conditionally exports all three canonical keys from INPUT_* (non-empty input wins)', () => {
    const src = readAction();
    const runBlocks = extractRunBlocks(src);
    // Contract: each INPUT_* var is conditionally exported to the canonical
    // name only when non-empty, preserving any inherited env value otherwise.
    const hasAnthropicExport = runBlocks.some((b) =>
      /\[\s*-n\s+"\$\{INPUT_ANTHROPIC_API_KEY:-\}"\s*\]\s*&&\s*export\s+ANTHROPIC_API_KEY/.test(b),
    );
    const hasOpenAiExport = runBlocks.some((b) =>
      /\[\s*-n\s+"\$\{INPUT_OPENAI_API_KEY:-\}"\s*\]\s*&&\s*export\s+OPENAI_API_KEY/.test(b),
    );
    const hasXaiExport = runBlocks.some((b) =>
      /\[\s*-n\s+"\$\{INPUT_XAI_API_KEY:-\}"\s*\]\s*&&\s*export\s+XAI_API_KEY/.test(b),
    );
    expect(hasAnthropicExport).toBe(
      true,
      'No run block conditionally exports ANTHROPIC_API_KEY from INPUT_ANTHROPIC_API_KEY.',
    );
    expect(hasOpenAiExport).toBe(
      true,
      'No run block conditionally exports OPENAI_API_KEY from INPUT_OPENAI_API_KEY.',
    );
    expect(hasXaiExport).toBe(
      true,
      'No run block conditionally exports XAI_API_KEY from INPUT_XAI_API_KEY.',
    );
  });

  it('all three canonical provider keys are unset when empty (run script guard)', () => {
    const src = readAction();
    const runBlocks = extractRunBlocks(src);
    // Contract: all three keys must be unset when empty after the conditional
    // exports, so SDKs never receive an empty string as a credential.
    const hasAnthropicUnset = runBlocks.some((b) =>
      /\[\s*-z\s+"\$\{ANTHROPIC_API_KEY:-\}"\s*\]\s*&&\s*unset\s+ANTHROPIC_API_KEY/.test(b),
    );
    const hasOpenAiUnset = runBlocks.some((b) =>
      /\[\s*-z\s+"\$\{OPENAI_API_KEY:-\}"\s*\]\s*&&\s*unset\s+OPENAI_API_KEY/.test(b),
    );
    const hasXaiUnset = runBlocks.some((b) =>
      /\[\s*-z\s+"\$\{XAI_API_KEY:-\}"\s*\]\s*&&\s*unset\s+XAI_API_KEY/.test(b),
    );
    expect(hasAnthropicUnset).toBe(
      true,
      'No run block unsets ANTHROPIC_API_KEY when empty. ' +
        'Add: [ -z "${ANTHROPIC_API_KEY:-}" ] && unset ANTHROPIC_API_KEY',
    );
    expect(hasOpenAiUnset).toBe(
      true,
      'No run block unsets OPENAI_API_KEY when empty. ' +
        'Add: [ -z "${OPENAI_API_KEY:-}" ] && unset OPENAI_API_KEY',
    );
    expect(hasXaiUnset).toBe(
      true,
      'No run block unsets XAI_API_KEY when empty. ' +
        'Add: [ -z "${XAI_API_KEY:-}" ] && unset XAI_API_KEY',
    );
  });

  it('all-keys-empty guard error message mentions inputs or inherited env', () => {
    const src = readAction();
    const runBlocks = extractRunBlocks(src);
    // Contract: the guard message must tell the caller that keys may come from
    // inputs OR from inherited env, not only from inputs.
    const hasUpdatedGuardMessage = runBlocks.some((b) =>
      /via inputs or inherited env/.test(b),
    );
    expect(hasUpdatedGuardMessage).toBe(
      true,
      'Guard error message should mention that keys may come from inputs or inherited env.',
    );
  });

  it('sets package_json_file to /dev/null on the pnpm setup step to avoid consumer packageManager conflicts', () => {
    const src = readAction();
    // pnpm/action-setup v6 reads the consumer package.json#packageManager field
    // by default. If the consumer specifies a different pnpm major it raises
    // "multiple versions of pnpm specified". Setting package_json_file to a
    // non-existent path prevents this.
    expect(src).toMatch(/package_json_file:\s*\/dev\/null/);
  });
});

// ---------------------------------------------------------------------------
// JSON output extraction — real afk chat --format json output shape
// ---------------------------------------------------------------------------

/**
 * Simulate the Node.js extraction script embedded in action.yml's run step.
 *
 * The script finds the last line that is exactly "{", parses from there to the
 * end as JSON, then returns obj.message. We exercise it here with fixture
 * output from buildOneShotJsonOutput so regressions in the parser are caught
 * without needing a live Anthropic call.
 */
function extractMessageFromJsonOutput(raw: string): string {
  const lines = raw.split('\n');
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() === '{') { start = i; break; }
  }
  if (start === -1) throw new Error('Could not find JSON object in afk output');
  const obj = JSON.parse(lines.slice(start).join('\n')) as Record<string, unknown>;
  if (typeof obj['message'] !== 'string') throw new Error('afk JSON output has no .message field');
  return obj['message'];
}

describe('afk chat --format json output — extraction', () => {
  /**
   * Minimal fixture: the fields always present in buildOneShotJsonOutput output.
   * JSON.stringify with indent=2 emits "{\n" so the opening brace is on its own
   * line — this is the invariant the action.yml parser relies on.
   */
  const minimalFixture = JSON.stringify(
    { success: true, model: 'claude-sonnet-4-5', message: 'Hello from afk!', timestamp: '2026-10-09T12:00:00.000Z' },
    null, 2,
  );

  /**
   * Full fixture: includes all optional metadata fields that buildOneShotJsonOutput
   * may emit (costUsd, durationMs, inputTokens, outputTokens, sessionId,
   * witnessLabel, tracePath).
   */
  const fullFixture = JSON.stringify(
    {
      success: true,
      model: 'claude-sonnet-4-5',
      message: 'The answer is 42.',
      timestamp: '2026-10-09T12:00:00.000Z',
      costUsd: 0.0012,
      durationMs: 3456,
      inputTokens: 512,
      outputTokens: 128,
      sessionId: 'abc123def456',
      witnessLabel: '2026-10-09T12-00-00-abc123',
      tracePath: '/home/runner/.afk/state/witness/2026-10-09T12-00-00-abc123/trace.jsonl',
    },
    null, 2,
  );

  it('extracts .message from minimal afk chat --format json output', () => {
    const msg = extractMessageFromJsonOutput(minimalFixture);
    expect(msg).toBe('Hello from afk!');
  });

  it('extracts .message from full afk chat --format json output (all optional fields present)', () => {
    const msg = extractMessageFromJsonOutput(fullFixture);
    expect(msg).toBe('The answer is 42.');
  });

  it('extracts .message when plugin warning lines precede the JSON object', () => {
    // The action comment says "Plugin warnings or other non-JSON lines may appear
    // before the JSON object." Verify the parser skips preamble lines.
    const withPreamble = [
      '⚠  Plugin "my-plugin" is missing a SKILL.md (skipping)',
      'Loading afk config from ~/.afk/config/afk.config.json',
      minimalFixture,
    ].join('\n');
    const msg = extractMessageFromJsonOutput(withPreamble);
    expect(msg).toBe('Hello from afk!');
  });

  it('extracts .message when the response contains embedded newlines', () => {
    const multiLineMessage = 'Line one.\nLine two.\nLine three.';
    const fixture = JSON.stringify(
      { success: true, model: 'claude-sonnet-4-5', message: multiLineMessage, timestamp: '2026-10-09T12:00:00.000Z' },
      null, 2,
    );
    const msg = extractMessageFromJsonOutput(fixture);
    expect(msg).toBe(multiLineMessage);
  });

  it('throws when the output has no JSON object (no line that is exactly "{")', () => {
    const noJson = 'Some random line\nAnother line\n';
    expect(() => extractMessageFromJsonOutput(noJson)).toThrow(
      'Could not find JSON object in afk output',
    );
  });

  it('throws when the parsed JSON has no .message field', () => {
    const noMessage = JSON.stringify({ success: true, model: 'x' }, null, 2);
    expect(() => extractMessageFromJsonOutput(noMessage)).toThrow(
      'afk JSON output has no .message field',
    );
  });

  it('opening brace of the JSON object is on its own line (JSON.stringify invariant)', () => {
    // JSON.stringify(obj, null, 2) always places { on the first line alone.
    // The action parser relies on this invariant to find the start of the object.
    const lines = minimalFixture.split('\n');
    expect(lines[0]).toBe('{');
  });

  it('output has success:true and a string model field', () => {
    const obj = JSON.parse(minimalFixture) as Record<string, unknown>;
    expect(obj['success']).toBe(true);
    expect(typeof obj['model']).toBe('string');
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
