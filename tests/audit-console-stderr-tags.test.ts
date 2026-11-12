import { describe, expect, it } from 'vitest';
import {
  STDERR_TAG_SCOPE,
  inStderrTagScope,
  isBracketTagStderrWrite,
} from '../scripts/audit-console-stderr-tags.js';

describe('bracket-tag stderr audit: detection', () => {
  it('flags the unconditional startup-recall timing write this rule was added for', () => {
    const line =
      '          process.stderr.write(`[startup-recall] findLatestCwdSession took ${elapsed.toFixed(0)}ms\\n`);';
    expect(isBracketTagStderrWrite(line, undefined)).toBe(true);
  });

  it.each([
    ["process.stderr.write('[afk] history write failed\\n');"],
    ['process.stderr.write("[mcp] warn\\n");'],
    ['process.stderr.write(`[afk preflight] ${cmd} stderr: ${out}\\n`);'],
    ['process.stderr.write(`[--post] publish failed: ${msg}\\n`);'],
    ['  process.stderr.write (  `[compositor] t=${t}\\n`);'],
  ])('flags a tagged literal as the first argument: %s', (line) => {
    expect(isBracketTagStderrWrite(line, undefined)).toBe(true);
  });

  it('flags the wrapped form, where the literal starts on the next line', () => {
    expect(
      isBracketTagStderrWrite(
        '        process.stderr.write(',
        "          '[afk] warning: AFK_STEER_MODE=boundary is set but the compositor does not expose ' +",
      ),
    ).toBe(true);
  });

  it.each([
    // Routed through the palette: the first argument is not a bare literal.
    ["process.stderr.write(palette.warning('[path-approval] provider lacks GrantManager') + '\\n');"],
    // The sanctioned developer path.
    ['debugLog(palette.dim(`  [startup-recall] findLatestCwdSession took ${ms}ms`));'],
    // Untagged text and plain variables.
    ["process.stderr.write('Update available\\n');"],
    ['process.stderr.write(lines.join("\\n"));'],
    // Terminal control sequences open with an escape, not a bracket tag.
    ["process.stderr.write('\\x1b[2K\\r');"],
    ['process.stderr.write(`\\x1b[?25h`);'],
    // A concatenated bracket is not a tag literal.
    ["process.stderr.write('[' + name + '] ready\\n');"],
    // Other streams and other methods are out of scope for this rule.
    ['process.stdout.write(`[afk] ready\\n`);'],
    ["console.warn('[hooks] command exited with code 1');"],
    // Prose that mentions the API is not a call. (Commented-out calls are
    // dropped earlier, by the comment-line skip in audit-console.ts.)
    ['never process.stderr.write a tagged line here'],
  ])('does not flag: %s', (line) => {
    expect(isBracketTagStderrWrite(line, undefined)).toBe(false);
  });

  it('does not flag a wrapped call whose next line is not a tagged literal', () => {
    expect(isBracketTagStderrWrite('process.stderr.write(', '  palette.dim(text),')).toBe(false);
    expect(isBracketTagStderrWrite('process.stderr.write(', undefined)).toBe(false);
  });

  it('ignores the next line when the argument starts on the call line', () => {
    expect(isBracketTagStderrWrite('process.stderr.write(text,', "  '[afk] not the first argument',")).toBe(false);
  });
});

describe('bracket-tag stderr audit: scope', () => {
  it('covers the REPL subtree', () => {
    expect(STDERR_TAG_SCOPE).toBe('src/cli/commands/interactive/');
    expect(inStderrTagScope('src/cli/commands/interactive/startup-recall.ts')).toBe(true);
    expect(inStderrTagScope('src/cli/commands/interactive/input/thing.ts')).toBe(true);
  });

  it('leaves one-shot commands and other surfaces alone', () => {
    expect(inStderrTagScope('src/cli/commands/whatif.ts')).toBe(false);
    expect(inStderrTagScope('src/cli/commands/acp.server.ts')).toBe(false);
    expect(inStderrTagScope('src/cli/commands/interactive.register-helpers.ts')).toBe(false);
    expect(inStderrTagScope('src/telegram/streaming.ts')).toBe(false);
  });
});
