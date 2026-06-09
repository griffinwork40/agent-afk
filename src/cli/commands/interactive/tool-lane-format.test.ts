/**
 * Tests for tool-lane-format helpers — focused on the per-tool argument
 * summarizer (bash `cd <dir> &&` stripping) and the per-category outcome
 * verb (grep/glob/read each get the right noun for their line-count).
 *
 * Pure-function tests; no ToolLane / no terminal state.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  summarizeToolArgs,
  formatOutcome,
  formatToolLine,
  formatDiffBlock,
  bracketPairAwareTruncate,
  sanitizeLabel,
  sanitizeTextParagraph,
  shortenPaths,
  MAX_OVERLAY_DIFF_LINES,
  FLUSH_DIFF_LINES_DEFAULT,
} from './tool-lane-format.js';
import { resetHyperlinksEnabledForTest } from '../../hyperlink.js';
import { stripAnsi, displayWidth } from '../../display.js';
import type { ToolResultChunk } from '../../../agent/types/message-types.js';
import type { DiffPayload } from '../../../utils/diff.js';

function makeResult(opts: {
  content?: string;
  lineCount?: number;
  isError?: boolean;
  persistedPath?: string;
  display?: string;
}): ToolResultChunk {
  return {
    type: 'tool_result',
    toolUseId: 'unused',
    content: opts.content ?? '',
    isError: opts.isError ?? false,
    ...(opts.lineCount !== undefined ? { lineCount: opts.lineCount } : {}),
    ...(opts.persistedPath !== undefined ? { persistedPath: opts.persistedPath } : {}),
    ...(opts.display !== undefined ? { display: opts.display } : {}),
  };
}

describe('summarizeToolArgs — bash cd-prefix stripping', () => {
  it('strips a single leading `cd <dir> && ` and surfaces the real command', () => {
    const out = summarizeToolArgs('bash', '(cd /Users/example/repo && pnpm test --filter ui)');
    expect(out).toContain('pnpm test');
    expect(out).not.toContain('cd /Users/example/repo');
  });

  it('strips with relative-path cd as well', () => {
    const out = summarizeToolArgs('bash', '(cd agent-afk && git diff HEAD)');
    expect(out).toContain('git diff HEAD');
    expect(out).not.toContain('cd agent-afk');
  });

  it('does NOT strip chained cd (cd a && cd b && cmd) — guards against eating a meaningful second cd', () => {
    const out = summarizeToolArgs('bash', '(cd workspace && cd repo && cmd)');
    expect(out).toContain('cd workspace');
    expect(out).toContain('cd repo');
  });

  it('does NOT strip bare `cd <dir>` with no following command', () => {
    expect(summarizeToolArgs('bash', '(cd /some/path)')).toContain('cd /some/path');
  });

  it('does NOT touch non-bash tools', () => {
    expect(summarizeToolArgs('read_file', '(cd foo && something)'))
      .toBe('(cd foo && something)');
  });

  it('handles capitalized Bash variant', () => {
    expect(summarizeToolArgs('Bash', '(cd repo && echo hi)')).toContain('echo hi');
  });

  it('fails open on malformed input', () => {
    expect(summarizeToolArgs('bash', '')).toBe('');
    expect(summarizeToolArgs('bash', 'no-cd-prefix-here')).toBe('no-cd-prefix-here');
  });

  it('fails open (returns input unchanged) on a heredoc bash arg that spans multiple lines', () => {
    const raw = 'cd /repo && cat <<EOF\nline1\nline2\nEOF';
    // After regex fix: multiline input does NOT match the single-line regex;
    // stripBashCdPrefix returns it unchanged (fail-open is the correct behavior).
    const out = summarizeToolArgs('bash', raw);
    expect(out).toBe(raw);
  });
});

/**
 * Subagent / skill dispatch tools — `agent`, `Agent`, `Task`, `skill`, `Skill`
 * — used to leak the raw JSON toolInput into the topology spine because
 * `summarizeToolArgs` had no handler and returned `args` unchanged. The
 * leak window is narrow (addStart → mergeAgentLabel) but on every paint
 * tick during it the spine reads e.g. `→ agent{"prompt":"**BUG 2..."}`.
 * These tests pin the new label-extraction behavior so the regression
 * cannot reopen.
 */
describe('summarizeToolArgs — agent/Task/skill JSON label extraction', () => {
  it('agent: extracts `id_prefix` when set (preferred over prompt)', () => {
    const args = JSON.stringify({ id_prefix: 'diagnose-h1', prompt: 'Investigate X' });
    expect(summarizeToolArgs('agent', args)).toBe('(diagnose-h1)');
  });

  it('agent: falls back to `prompt` when id_prefix is absent', () => {
    const args = JSON.stringify({ prompt: 'Look at the spine bug' });
    expect(summarizeToolArgs('agent', args)).toBe('(Look at the spine bug)');
  });

  it('agent: collapses prompt whitespace to a single line before clipping', () => {
    const args = JSON.stringify({ prompt: 'line1\n\n   line2\n  line3' });
    const out = summarizeToolArgs('agent', args);
    expect(out).toBe('(line1 line2 line3)');
    expect(out).not.toContain('\n');
  });

  it('agent: clips long prompts at 60 display columns with ellipsis', () => {
    const long = 'a'.repeat(120);
    const out = summarizeToolArgs('agent', JSON.stringify({ prompt: long }));
    // truncateDisplayWidth(flat, 60, '…') reserves 1 col for the ellipsis,
    // so the body is 59 ASCII chars + '…' = exactly 60 display columns.
    expect(out).toBe('(' + 'a'.repeat(59) + '…)');
  });

  it('agent: handles capitalized Agent variant', () => {
    expect(summarizeToolArgs('Agent', JSON.stringify({ id_prefix: 'verifier' })))
      .toBe('(verifier)');
  });

  it('agent: tolerates `(...)`-wrapped JSON arriving from the chunk formatter', () => {
    const args = `(${JSON.stringify({ prompt: 'wrapped' })})`;
    expect(summarizeToolArgs('agent', args)).toBe('(wrapped)');
  });

  it('Task: prefers `description` over `prompt` (Anthropic naming)', () => {
    const args = JSON.stringify({
      description: 'BUG 2: spine narration',
      prompt: 'Long body of the task...',
      subagent_type: 'general',
    });
    expect(summarizeToolArgs('Task', args)).toBe('(BUG 2: spine narration)');
  });

  it('Task: falls back to `prompt` when description is absent', () => {
    const args = JSON.stringify({ prompt: 'No description set' });
    expect(summarizeToolArgs('Task', args)).toBe('(No description set)');
  });

  it('Task: regression — does NOT leak the raw `"description":` JSON key (the original bug)', () => {
    const args = JSON.stringify({ description: '**BUG 2 — the topology spine is broken' });
    const out = summarizeToolArgs('Task', args);
    expect(out).not.toContain('"description"');
    expect(out).not.toContain('{');
    expect(out).not.toContain('}');
    expect(out).toContain('BUG 2');
  });

  it('skill: extracts the `name` field', () => {
    const args = JSON.stringify({ name: 'diagnose', arguments: 'topology spine bug' });
    expect(summarizeToolArgs('skill', args)).toBe('(diagnose)');
  });

  it('skill: handles capitalized Skill variant', () => {
    expect(summarizeToolArgs('Skill', JSON.stringify({ name: 'mint' })))
      .toBe('(mint)');
  });

  it('skill: falls back to `arguments` when name is missing (defensive)', () => {
    const args = JSON.stringify({ arguments: 'inline body' });
    expect(summarizeToolArgs('skill', args)).toBe('(inline body)');
  });

  it('fails open (returns args unchanged) on malformed JSON', () => {
    const raw = '{not valid json';
    expect(summarizeToolArgs('agent', raw)).toBe(raw);
    expect(summarizeToolArgs('Task', raw)).toBe(raw);
    expect(summarizeToolArgs('skill', raw)).toBe(raw);
  });

  it('fails open when none of the expected fields are present', () => {
    const args = JSON.stringify({ unrelated: 'field' });
    expect(summarizeToolArgs('agent', args)).toBe(args);
    expect(summarizeToolArgs('Task', args)).toBe(args);
  });

  it('fails open on empty string', () => {
    expect(summarizeToolArgs('agent', '')).toBe('');
    expect(summarizeToolArgs('Task', '')).toBe('');
    expect(summarizeToolArgs('skill', '')).toBe('');
  });

  it('fails open on JSON whose target field is empty/whitespace', () => {
    const args = JSON.stringify({ prompt: '   ', id_prefix: '' });
    expect(summarizeToolArgs('agent', args)).toBe(args);
  });

  it('does NOT touch unrelated tools', () => {
    const args = JSON.stringify({ prompt: 'unrelated' });
    expect(summarizeToolArgs('read_file', args)).toBe(args);
    expect(summarizeToolArgs('grep', args)).toBe(args);
  });

  // ── Security regression: ANSI / control-byte scrubbing ─────────────────

  it('S1: ANSI/control bytes are scrubbed from extracted labels (CSI sequence + BEL)', () => {
    // \x1b[2J is the "erase display" CSI sequence; \x07 is BEL.
    // After extraction, neither the ESC byte nor any other C0/C1 byte should
    // survive into the returned label. This pins that sanitizeLabel is called
    // INSIDE summarizeNestingArgs, after JSON.parse.
    const args = JSON.stringify({ prompt: '\x1b[2J\x07clear' });
    const out = summarizeToolArgs('agent', args);
    expect(out).not.toMatch(/[\x00-\x1F\x7F-\x9F]/);
    expect(out).toContain('clear'); // visible text is preserved
  });

  it('S2: unicode-escaped ESC sequences are scrubbed (JSON.parse amplification)', () => {
    // JSON.stringify embeds the ESC as \u001b; JSON.parse re-inflates it to a
    // real 0x1B byte AFTER any outer stripAnsi pass. The scrub must therefore
    // happen AFTER parsing, which is exactly where sanitizeLabel now sits.
    // This test pins the post-parse sanitization invariant.
    const rawJson = '{"prompt":"\\u001b[31mRED"}';
    const out = summarizeToolArgs('agent', rawJson);
    expect(out).not.toMatch(/[\x00-\x1F\x7F-\x9F]/);
    expect(out).toContain('RED'); // visible text is preserved
  });

  // ── Top-level JSON array — fail-open ────────────────────────────────────

  it('fails open (returns args unchanged) when JSON parses to a top-level array', () => {
    // JSON.parse('[1,2,3]') returns an Array. Arrays satisfy `typeof obj ===
    // 'object'`, so the type-guard does NOT catch this — instead the function
    // falls through to the "no matching field" path and returns args unchanged.
    const args = '[1,2,3]';
    expect(summarizeToolArgs('agent', args)).toBe(args);
  });

  // ── Lowercase `task` — unregistered tool name ───────────────────────────

  it("lowercase 'task' is not handled (case-sensitive gap) — returns args unchanged", () => {
    // Only 'Task' (capital T) is registered. 'task' falls through to the
    // default `return args` branch. This test documents current behavior so
    // that any future change to add case-insensitivity is explicit and
    // deliberate.
    const taskArgs = JSON.stringify({ description: 'test' });
    expect(summarizeToolArgs('task', taskArgs)).toBe(taskArgs);
  });
});

/**
 * ask_question summarization — the tool-lane row must NOT echo the
 * `question` string because the elicitation overlay already renders
 * it (buildOverlayHeader in elicitation-repl.ts). Dedup prevents the
 * "looks duped" UX where the question text appears in both the tool
 * row and the overlay frame simultaneously.
 */
describe('summarizeToolArgs — ask_question category-only summary', () => {
  it('text: returns `(text)` and does not contain the question string', () => {
    const args = JSON.stringify({ type: 'text', question: 'What is your name?' });
    const out = summarizeToolArgs('ask_question', args);
    expect(out).toBe('(text)');
    expect(out).not.toContain('What is your name?');
  });

  it('confirm: returns `(confirm)`', () => {
    const args = JSON.stringify({ type: 'confirm', question: 'Continue?' });
    expect(summarizeToolArgs('ask_question', args)).toBe('(confirm)');
  });

  it('number: returns `(number)`', () => {
    const args = JSON.stringify({ type: 'number', question: 'How many?' });
    expect(summarizeToolArgs('ask_question', args)).toBe('(number)');
  });

  it('choice with N options: returns `(choice: N options)`', () => {
    const args = JSON.stringify({
      type: 'choice',
      question: 'Pick one:',
      choices: ['alpha', 'beta', 'gamma'],
    });
    expect(summarizeToolArgs('ask_question', args)).toBe('(choice: 3 options)');
  });

  it('choice with 1 option: singular noun', () => {
    const args = JSON.stringify({ type: 'choice', choices: ['only'] });
    expect(summarizeToolArgs('ask_question', args)).toBe('(choice: 1 option)');
  });

  it('multi_choice with N options: returns `(multi_choice: N options)`', () => {
    const args = JSON.stringify({
      type: 'multi_choice',
      question: 'Pick several:',
      choices: ['a', 'b', 'c', 'd', 'e'],
    });
    expect(summarizeToolArgs('ask_question', args)).toBe('(multi_choice: 5 options)');
  });

  it('defaults to text when type is absent', () => {
    const args = JSON.stringify({ question: 'No type field' });
    expect(summarizeToolArgs('ask_question', args)).toBe('(text)');
  });

  it('accepts paren-wrapped JSON (compose-style)', () => {
    const args = '(' + JSON.stringify({ type: 'text', question: 'wrapped' }) + ')';
    expect(summarizeToolArgs('ask_question', args)).toBe('(text)');
  });

  it('fails open on malformed JSON — returns args unchanged', () => {
    const args = '{ not valid json';
    expect(summarizeToolArgs('ask_question', args)).toBe(args);
  });

  it('fails open on non-object JSON — returns args unchanged', () => {
    expect(summarizeToolArgs('ask_question', '"just a string"')).toBe('"just a string"');
    expect(summarizeToolArgs('ask_question', '42')).toBe('42');
  });
});

describe('formatToolLine — agent/Task/skill end-to-end (paren-balanced under truncation)', () => {
  it('agent: full pipeline renders `→ agent(label) [subagent]` instead of raw JSON', () => {
    const args = JSON.stringify({ prompt: 'BUG 2 — fix spine narration' });
    const out = stripAnsi(formatToolLine('agent' + args));
    expect(out).toContain('agent(BUG 2 — fix spine narration)');
    expect(out).toContain('[subagent]');
    expect(out).not.toContain('"prompt"');
    expect(out).not.toContain('{');
  });

  it('Task: full pipeline renders `→ Task(description) [subagent]`', () => {
    const args = JSON.stringify({ description: 'spine bug', prompt: 'long body' });
    const out = stripAnsi(formatToolLine('Task' + args));
    expect(out).toContain('Task(spine bug)');
    expect(out).toContain('[subagent]');
  });

  it('skill: full pipeline renders `◆ skill(name) [skill]`', () => {
    const args = JSON.stringify({ name: 'diagnose', arguments: 'foo' });
    const out = stripAnsi(formatToolLine('skill' + args));
    expect(out).toContain('skill(diagnose)');
    expect(out).toContain('[skill]');
  });

  it('agent: narrow maxWidth preserves the closing paren (bracket-pair-aware truncation)', () => {
    const args = JSON.stringify({ prompt: 'this is a very long prompt that will be clipped' });
    const out = stripAnsi(formatToolLine('agent' + args, 30));
    // Must end with `) [subagent]` — the closing paren survives truncation
    expect(out).toMatch(/…\) \[subagent\]$/);
  });
});

describe('formatOutcome — per-category outcome verbs', () => {
  it('grep result renders as "N matches", not "N lines"', () => {
    const out = stripAnsi(formatOutcome(makeResult({ lineCount: 5 }), undefined, 60, 'grep'));
    expect(out).toContain('5 matches');
    expect(out).not.toContain('lines');
  });

  it('glob result renders as "N paths"', () => {
    const out = stripAnsi(formatOutcome(makeResult({ lineCount: 7 }), undefined, 60, 'glob'));
    expect(out).toContain('7 paths');
  });

  it('read_file result still renders as "N lines"', () => {
    const out = stripAnsi(formatOutcome(makeResult({ lineCount: 45 }), undefined, 60, 'read_file'));
    expect(out).toContain('45 lines');
  });

  it('bash result renders as "N lines" (stdout volume)', () => {
    const out = stripAnsi(formatOutcome(makeResult({ lineCount: 453 }), undefined, 60, 'bash'));
    expect(out).toContain('453 lines');
  });

  it('no toolName falls back to "lines"', () => {
    const out = stripAnsi(formatOutcome(makeResult({ lineCount: 12 })));
    expect(out).toContain('12 lines');
  });

  it('persistedPath renders as "saved → <path>" regardless of tool', () => {
    const out = stripAnsi(formatOutcome(makeResult({ persistedPath: '/tmp/foo' }), undefined, 60, 'write_file'));
    expect(out).toContain('saved →');
  });
});

describe('formatOutcome — chunk.display passthrough (handler-supplied display string)', () => {
  // Memory tools (and any future tool that returns JSON content) populate
  // `ToolResult.display`. The renderer is a dumb passthrough: when present,
  // show it verbatim. Display strings produced by the handler are short by
  // construction — they bypass the upstream truncation logic in
  // stream-consumer.ts that would otherwise mangle JSON content.

  it('renders display verbatim instead of slicing content', () => {
    const out = stripAnsi(
      formatOutcome(
        makeResult({
          content: '[{"type":"fact","content":"something long that would leak"}]',
          display: '3 results (2 facts, 1 procedure)',
        }),
        undefined,
        60,
        'memory_search',
      ),
    );
    expect(out).toBe('3 results (2 facts, 1 procedure)');
    expect(out).not.toContain('"type"');
  });

  it('display wins over the lineCount branch (handler-rendered, not line-counted)', () => {
    // Memory results are single-line JSON, but if a tool emits display AND
    // happens to also have a lineCount, display takes precedence.
    const out = stripAnsi(
      formatOutcome(
        makeResult({ content: 'irrelevant', display: 'hot memory saved', lineCount: 5 }),
        undefined,
        60,
        'memory_update',
      ),
    );
    expect(out).toBe('hot memory saved');
  });

  it('display is skipped on error so the user sees the actual error text', () => {
    // Error path: handler returns `memory_search error: <message>` as
    // content with isError: true and no display field. But even if a
    // handler bug set display alongside isError, the renderer prefers
    // the error content so the failure is visible.
    const out = stripAnsi(
      formatOutcome(
        makeResult({
          content: 'memory_search error: bad query',
          isError: true,
          display: 'fact removed', // hypothetical handler bug
        }),
        undefined,
        80,
        'memory_search',
      ),
    );
    expect(out).toContain('memory_search error: bad query');
    expect(out).not.toContain('fact removed');
  });

  it('chunks without display fall through to the existing content/lineCount/preview path', () => {
    // Regression guard: tools that don't set display (bash, read_file,
    // grep, etc.) keep their existing rendering.
    const out = stripAnsi(formatOutcome(makeResult({ lineCount: 7 }), undefined, 60, 'grep'));
    expect(out).toContain('7 matches');
  });

  it('persistedPath still renders normally when display is absent', () => {
    const out = stripAnsi(
      formatOutcome(makeResult({ persistedPath: '/tmp/foo' }), undefined, 60, 'write_file'),
    );
    expect(out).toContain('saved →');
  });

  it('content-preview path scrubs LLM-injected control bytes (M1 regression)', () => {
    // Pre-fix shape used sanitizePrefixString(stripAnsi(...)) — that path
    // scrubbed CSI/OSC sequences via stripAnsi but left bare BEL (0x07),
    // backspace (0x08), DEL (0x7F), and C1 controls untouched. M1 swapped
    // formatOutcome to sanitizeLabel, which catches every C0 + C1 + DEL
    // byte. This test pins the new contract: none of those bytes survive
    // through to the terminal-bound preview string.
    const adversarial = 'normal text\x07with\x08bell\x7fand\u009Bdel';
    const out = formatOutcome(makeResult({ content: adversarial }), undefined, 100);
    // Raw output (palette-colored). Strip the wrapping ANSI from the
    // result-color span to inspect the actual preview payload.
    const stripped = stripAnsi(out);
    expect(stripped).not.toMatch(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/);
    expect(stripped).toContain('normal text');
    expect(stripped).toContain('bell');
  });

  it('content-preview path scrubs raw ANSI CSI sequences from chunk.content', () => {
    // Pre-fix coverage already existed for this case (stripAnsi was in the
    // pipeline). Keep the test to lock the invariant under the new
    // sanitizeLabel pipeline so a future refactor cannot drop the ANSI
    // scrub by accident.
    const adversarial = '\x1b[31mred preview\x1b[0m';
    const out = stripAnsi(formatOutcome(makeResult({ content: adversarial }), undefined, 100));
    expect(out).not.toMatch(/\x1B/);
    expect(out).toContain('red preview');
  });
});

describe('formatToolLine — prefix newline safety', () => {
  it('never returns a string containing \\n for heredoc bash input', () => {
    const result = stripAnsi(formatToolLine('bash cd /repo && cat <<EOF\nline1\nline2\nEOF'));
    expect(result).not.toMatch(/[\r\n]/);
  });

  it('never returns a string containing \\n with maxWidth set and heredoc input', () => {
    const result = stripAnsi(formatToolLine('bash cd /repo && cat <<EOF\nline1\nEOF', 80));
    expect(result).not.toMatch(/[\r\n]/);
  });
});

describe('bracketPairAwareTruncate', () => {
  it('preserves closing paren when truncating balanced args', () => {
    // `(review)` is 8 cols; at width 6 we need `(rev…)` (balanced, not `(revi…`).
    expect(bracketPairAwareTruncate('(review)', 6)).toBe('(rev…)');
  });

  it('preserves closing curly brace on balanced JSON-like args', () => {
    expect(bracketPairAwareTruncate('{node: 1}', 5)).toBe('{no…}');
  });

  it('preserves closing square bracket on balanced array-like args', () => {
    expect(bracketPairAwareTruncate('[a, b, c, d]', 6)).toBe('[a, …]');
  });

  it('returns args unchanged when it fits within maxWidth', () => {
    expect(bracketPairAwareTruncate('(review)', 20)).toBe('(review)');
    expect(bracketPairAwareTruncate('(review)', 8)).toBe('(review)');
  });

  it('falls back to plain truncate when args is not bracket-balanced', () => {
    // No opener — plain truncation eats the trailing chars and adds ellipsis.
    expect(bracketPairAwareTruncate('plain text here', 5)).toBe('plai…');
  });

  it('falls back to plain truncate when opener has no matching closer', () => {
    // `(unclosed` starts with `(` but does not end with `)`. Not balanced.
    expect(bracketPairAwareTruncate('(unclosed', 5)).toBe('(unc…');
  });

  it('collapses to opener+closer when maxWidth=2 (no room for ellipsis)', () => {
    // At width 2 we can fit `()` but not `(…)`. Prefer balanced empty over
    // unmatched opener. This is the case that produced the user-visible
    // `Agent(…` bug — argsMaxWidth dropped to 2 on narrow terminals.
    expect(bracketPairAwareTruncate('(review)', 2)).toBe('()');
    expect(bracketPairAwareTruncate('{long key: value}', 2)).toBe('{}');
    expect(bracketPairAwareTruncate('[1, 2, 3]', 2)).toBe('[]');
  });

  it('plain-truncates when maxWidth=1 (no room for even open+close)', () => {
    // At width 1 we cannot fit a pair; plain truncate produces `…`.
    expect(bracketPairAwareTruncate('(review)', 1)).toBe('…');
  });

  it('plain-truncates when maxWidth=0', () => {
    expect(bracketPairAwareTruncate('(review)', 0)).toBe('');
  });
});

describe('shortenPaths — URL-safety + fs-path collapsing', () => {
  it('collapses absolute fs paths with 3+ segments to basename', () => {
    expect(shortenPaths('/Users/me/proj/src/x.ts')).toBe('x.ts');
  });

  it('preserves short fs paths with < 3 segments', () => {
    expect(shortenPaths('/tmp/file.ts')).toBe('/tmp/file.ts');
  });

  it('collapses fs paths embedded in a bash command', () => {
    expect(shortenPaths('git -C /Users/me/proj/agent-afk log')).toBe('git -C agent-afk log');
  });

  it('preserves a bare-domain URL', () => {
    expect(shortenPaths(' https://example.com')).toBe(' https://example.com');
  });

  it('preserves a URL with a multi-segment path (regression: was https:/reference)', () => {
    expect(shortenPaths(' https://example.com/docs/api/reference')).toBe(
      ' https://example.com/docs/api/reference',
    );
  });

  it('preserves a deep URL path', () => {
    expect(shortenPaths(' https://api.github.com/repos/foo/bar/pulls/123')).toBe(
      ' https://api.github.com/repos/foo/bar/pulls/123',
    );
  });

  it('preserves a URL with commas before later path segments', () => {
    expect(shortenPaths('curl https://example.com/a,b/c/d/e')).toBe(
      'curl https://example.com/a,b/c/d/e',
    );
  });

  it('preserves a URL with a closing parenthesis before later path segments', () => {
    expect(shortenPaths('curl https://example.com/a)b/c/d/e')).toBe(
      'curl https://example.com/a)b/c/d/e',
    );
  });

  it('preserves a URL embedded in a bash command while not collapsing it', () => {
    expect(shortenPaths('curl https://api.example.com/v1/users/42/posts | jq')).toBe(
      'curl https://api.example.com/v1/users/42/posts | jq',
    );
  });

  it('preserves the URL but still collapses an adjacent fs path', () => {
    expect(shortenPaths('see https://x.com/a/b/c then /Users/me/proj/src/y.ts')).toBe(
      'see https://x.com/a/b/c then y.ts',
    );
  });
});

describe('shortenPaths — OSC 8 hyperlink emission', () => {
  afterEach(() => resetHyperlinksEnabledForTest());

  it('emits no escapes when hyperlinks are disabled (non-TTY default)', () => {
    resetHyperlinksEnabledForTest(false);
    expect(shortenPaths('/Users/me/proj/src/x.ts')).toBe('x.ts');
  });

  it('wraps the collapsed basename in a file:// link to the full path when enabled', () => {
    resetHyperlinksEnabledForTest(true);
    const out = shortenPaths('/Users/me/proj/src/x.ts');
    expect(stripAnsi(out)).toBe('x.ts');
    expect(out).toContain('\x1b]8;;file:///Users/me/proj/src/x.ts\x1b\\');
    expect(out).toContain('\x1b]8;;\x1b\\'); // close sequence present
  });

  it('zero-width invariant: linked output measures identical to plain output', () => {
    resetHyperlinksEnabledForTest(true);
    const linked = shortenPaths('git -C /Users/me/proj/agent-afk log');
    resetHyperlinksEnabledForTest(false);
    const plain = shortenPaths('git -C /Users/me/proj/agent-afk log');
    expect(displayWidth(linked)).toBe(displayWidth(plain));
    expect(stripAnsi(linked)).toBe(plain);
  });

  it('does not linkify URLs or short paths', () => {
    resetHyperlinksEnabledForTest(true);
    expect(shortenPaths(' https://example.com/docs/api/reference')).toBe(
      ' https://example.com/docs/api/reference',
    );
    expect(shortenPaths('/tmp/file.ts')).toBe('/tmp/file.ts');
  });

  it('percent-encodes spaces in the link target', () => {
    resetHyperlinksEnabledForTest(true);
    const out = shortenPaths('/Users/me/My\u00a0Project/src/x.ts');
    // Path with non-break space segment still produces an encoded URI and
    // an intact visible basename.
    expect(stripAnsi(out)).toContain('x.ts');
  });

  it('formatToolLine keeps the link intact through width budgeting', () => {
    resetHyperlinksEnabledForTest(true);
    const out = formatToolLine('read_file(/Users/me/proj/src/index.ts)', 80);
    expect(stripAnsi(out)).toContain('index.ts');
    expect(out).toContain('file:///Users/me/proj/src/index.ts');
    // Balanced open/close: no link bleed past the row.
    const opens = (out.match(/\x1b\]8;;file[^\x1b]*\x1b\\/g) ?? []).length;
    const closes = (out.match(/\x1b\]8;;\x1b\\/g) ?? []).length;
    expect(opens).toBe(closes);
  });
});

describe('formatOutcome — persistedPath hyperlink', () => {
  afterEach(() => resetHyperlinksEnabledForTest());

  it('links the ~-shortened display path to the absolute path when enabled', () => {
    resetHyperlinksEnabledForTest(true);
    const out = formatOutcome(
      makeResult({ persistedPath: '/home/u/.afk/state/out.txt' }),
      '/home/u',
    );
    expect(stripAnsi(out)).toContain('saved → ~/.afk/state/out.txt');
    expect(out).toContain('file:///home/u/.afk/state/out.txt');
  });

  it('renders plain text when disabled', () => {
    resetHyperlinksEnabledForTest(false);
    const out = formatOutcome(
      makeResult({ persistedPath: '/home/u/.afk/state/out.txt' }),
      '/home/u',
    );
    expect(out).not.toContain(']8;;');
  });
});

describe('formatToolLine — web_scrape URL rendering', () => {
  it('renders the full scraped URL (not a mangled basename)', () => {
    const result = stripAnsi(formatToolLine('web_scrape https://example.com/docs/api/reference'));
    expect(result).toContain('https://example.com/docs/api/reference');
    expect(result).not.toContain('https:/reference');
  });

  it('renders the URL host even when present (regression guard)', () => {
    const result = stripAnsi(formatToolLine('web_scrape https://www.anthropic.com/news/some-post'));
    expect(result).toContain('www.anthropic.com');
  });
});

describe('formatToolLine — bracket-pair preservation (Fix 4)', () => {
  it('never leaves an unmatched paren in Agent dispatch args at narrow widths', () => {
    // At width 20 with `Agent(review) [subagent]`, the previous code
    // produced `Agent(… [subagent]` — the closing `)` got eaten while
    // the dispatch tag ` [subagent]` consumed the remaining budget.
    const result = stripAnsi(formatToolLine('Agent(review)', 20));
    expect(result).not.toMatch(/\(…(?! *\))/); // no `(…` without a matching `)` later
    // Either `(review)` fits, or it collapses to `()` — but never unmatched.
    expect(result).toMatch(/Agent(\(review\)|\(\))/);
  });

  it('preserves closing paren on JSON-shape args (orchestrator agent dispatch)', () => {
    const result = stripAnsi(formatToolLine('agent({"prompt":"long prompt","id_prefix":"x"})', 30));
    // Should end with `…)` or contain a matched pair, not bare `…`.
    expect(result).toMatch(/\(.*\)/);
  });

  it('does not over-truncate when args fits within budget', () => {
    // `Agent(review)` at width 30 has plenty of room — no truncation expected.
    const result = stripAnsi(formatToolLine('Agent(review)', 30));
    expect(result).toContain('(review)');
    expect(result).not.toContain('…');
  });
});

describe('formatDiffBlock — render-only diff rendering', () => {
  function makeDiff(): DiffPayload {
    return {
      addedLines: 1,
      removedLines: 1,
      hunks: [
        {
          oldStart: 5,
          oldLines: 3,
          newStart: 5,
          newLines: 3,
          lines: [
            { kind: ' ', text: 'context line' },
            { kind: '-', text: 'old line' },
            { kind: '+', text: 'new line' },
          ],
        },
      ],
    };
  }

  it('emits a stat header, then a hunk header, then colored body lines', () => {
    const lines = formatDiffBlock(makeDiff(), 'flush', '    ').map(stripAnsi);
    // Stat header — first line, always present
    expect(lines[0]).toBe('    +1 -1 across 1 hunk');
    // Hunk header
    expect(lines[1]).toBe('    @@ -5,3 +5,3 @@');
    // Body — single-char prefix + space + text
    expect(lines[2]).toBe('      context line');
    expect(lines[3]).toBe('    - old line');
    expect(lines[4]).toBe('    + new line');
  });

  it('stat header uses plural "hunks" when count > 1, singular otherwise', () => {
    const lines = formatDiffBlock(makeDiff(), 'flush', '').map(stripAnsi);
    expect(lines[0]).toBe('+1 -1 across 1 hunk');

    const multi: DiffPayload = {
      addedLines: 3,
      removedLines: 2,
      hunks: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [{ kind: '+', text: 'a' }] },
        { oldStart: 9, oldLines: 1, newStart: 10, newLines: 2, lines: [{ kind: '+', text: 'b' }] },
        { oldStart: 20, oldLines: 1, newStart: 22, newLines: 2, lines: [{ kind: '+', text: 'c' }] },
      ],
    };
    const multiLines = formatDiffBlock(multi, 'flush', '').map(stripAnsi);
    expect(multiLines[0]).toBe('+3 -2 across 3 hunks');
  });

  it('applies the indent to every emitted line including the stat header', () => {
    const lines = formatDiffBlock(makeDiff(), 'flush', '>>>>');
    for (const line of lines) expect(line.startsWith('>>>>')).toBe(true);
  });

  it('caps overlay mode at MAX_OVERLAY_DIFF_LINES body lines with a footer', () => {
    // 20-line hunk → way over the cap. One header + 20 body lines.
    const lines: { kind: ' ' | '+' | '-'; text: string }[] = Array.from({ length: 20 }, (_, i) => ({
      kind: '+' as const,
      text: `added ${i}`,
    }));
    const diff: DiffPayload = {
      addedLines: 20,
      removedLines: 0,
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 20, lines }],
    };
    const overlay = formatDiffBlock(diff, 'overlay', '  ').map(stripAnsi);
    // 1 stat header + 1 hunk header + MAX_OVERLAY_DIFF_LINES body lines + 1 footer
    expect(overlay).toHaveLength(1 + 1 + MAX_OVERLAY_DIFF_LINES + 1);
    expect(overlay[overlay.length - 1]).toMatch(/^\s*… \+\d+ more diff line/);
    // Overlay footer is the SHORT form — no env-var hint.
    expect(overlay[overlay.length - 1]).not.toContain('AFK_DIFF_LINES');
  });

  it('F16: caps overlay body lines correctly with multiple hunks (headers excluded from cap)', () => {
    // 2 hunks × 5 body lines each = 10 body lines, 2 hunk headers → 12 items total.
    // The cap is 8 body lines, so we expect:
    //   - 1 stat header (new)
    //   - 2 hunk headers
    //   - 8 body lines (not 6, which would happen if headers counted against the cap)
    //   - 1 footer ("… +2 more diff lines")
    const makeLines = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ kind: '+' as const, text: `added ${i}` }));
    const diff: DiffPayload = {
      addedLines: 10,
      removedLines: 0,
      hunks: [
        { oldStart: 1, oldLines: 0, newStart: 1, newLines: 5, lines: makeLines(5) },
        { oldStart: 20, oldLines: 0, newStart: 21, newLines: 5, lines: makeLines(5) },
      ],
    };
    const overlay = formatDiffBlock(diff, 'overlay', '  ').map(stripAnsi);
    // 1 stat + 2 hunk headers + 8 body lines + 1 footer = 12 total
    expect(overlay).toHaveLength(1 + 2 + MAX_OVERLAY_DIFF_LINES + 1);
    // Footer should report 2 hidden body lines (10 total − 8 cap)
    expect(overlay[overlay.length - 1]).toMatch(/^\s*… \+2 more diff lines/);
    // Both hunk headers should be present
    const headers = overlay.filter((l) => l.trimStart().startsWith('@@'));
    expect(headers).toHaveLength(2);
  });

  it('flush mode truncates body at FLUSH_DIFF_LINES_DEFAULT (30) by default', () => {
    // 50-line hunk → over the default flush cap of 30.
    const lines: { kind: ' ' | '+' | '-'; text: string }[] = Array.from({ length: 50 }, (_, i) => ({
      kind: '+' as const,
      text: `added ${i}`,
    }));
    const diff: DiffPayload = {
      addedLines: 50,
      removedLines: 0,
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 50, lines }],
    };
    // Guard: ensure no test-runner ambient env overrides our default.
    const original = process.env['AFK_DIFF_LINES'];
    delete process.env['AFK_DIFF_LINES'];
    try {
      const flush = formatDiffBlock(diff, 'flush', '  ').map(stripAnsi);
      // 1 stat header + 1 hunk header + 30 body lines + 1 footer = 33
      expect(flush).toHaveLength(1 + 1 + FLUSH_DIFF_LINES_DEFAULT + 1);
      // Footer reports 20 hidden lines and names the env var to expand.
      expect(flush[flush.length - 1]).toContain('+20 more diff lines');
      expect(flush[flush.length - 1]).toContain('AFK_DIFF_LINES=0 to expand');
    } finally {
      if (original === undefined) delete process.env['AFK_DIFF_LINES'];
      else process.env['AFK_DIFF_LINES'] = original;
    }
  });

  it('flush mode renders the full diff when body fits under the cap', () => {
    // 5-line hunk → well under the 30-line cap, no truncation, no footer.
    const lines: { kind: ' ' | '+' | '-'; text: string }[] = Array.from({ length: 5 }, (_, i) => ({
      kind: '+' as const,
      text: `added ${i}`,
    }));
    const diff: DiffPayload = {
      addedLines: 5,
      removedLines: 0,
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 5, lines }],
    };
    const flush = formatDiffBlock(diff, 'flush', '  ').map(stripAnsi);
    // 1 stat header + 1 hunk header + 5 body lines = 7, no footer
    expect(flush).toHaveLength(7);
    expect(flush.some((l) => /more diff line/.test(l))).toBe(false);
  });

  it('AFK_DIFF_LINES=0 disables the flush cap (full diff renders)', () => {
    const original = process.env['AFK_DIFF_LINES'];
    process.env['AFK_DIFF_LINES'] = '0';
    try {
      const lines: { kind: ' ' | '+' | '-'; text: string }[] = Array.from(
        { length: 100 },
        (_, i) => ({ kind: '+' as const, text: `added ${i}` }),
      );
      const diff: DiffPayload = {
        addedLines: 100,
        removedLines: 0,
        hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 100, lines }],
      };
      const flush = formatDiffBlock(diff, 'flush', '  ').map(stripAnsi);
      // 1 stat header + 1 hunk header + 100 body lines = 102, no footer
      expect(flush).toHaveLength(102);
      expect(flush.some((l) => /more diff line/.test(l))).toBe(false);
    } finally {
      if (original === undefined) delete process.env['AFK_DIFF_LINES'];
      else process.env['AFK_DIFF_LINES'] = original;
    }
  });

  it('AFK_DIFF_LINES=N overrides the flush cap to N', () => {
    const original = process.env['AFK_DIFF_LINES'];
    process.env['AFK_DIFF_LINES'] = '10';
    try {
      const lines: { kind: ' ' | '+' | '-'; text: string }[] = Array.from(
        { length: 25 },
        (_, i) => ({ kind: '+' as const, text: `added ${i}` }),
      );
      const diff: DiffPayload = {
        addedLines: 25,
        removedLines: 0,
        hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 25, lines }],
      };
      const flush = formatDiffBlock(diff, 'flush', '  ').map(stripAnsi);
      // 1 stat header + 1 hunk header + 10 body lines + 1 footer = 13
      expect(flush).toHaveLength(13);
      expect(flush[flush.length - 1]).toContain('+15 more diff lines');
    } finally {
      if (original === undefined) delete process.env['AFK_DIFF_LINES'];
      else process.env['AFK_DIFF_LINES'] = original;
    }
  });

  it('invalid AFK_DIFF_LINES values fall back to the default cap', () => {
    const original = process.env['AFK_DIFF_LINES'];
    try {
      // 50-line hunk so the default-30 cap visibly truncates.
      const lines: { kind: ' ' | '+' | '-'; text: string }[] = Array.from(
        { length: 50 },
        (_, i) => ({ kind: '+' as const, text: `added ${i}` }),
      );
      const diff: DiffPayload = {
        addedLines: 50,
        removedLines: 0,
        hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 50, lines }],
      };
      for (const bad of ['abc', '-5', '  ', '1.5xyz']) {
        process.env['AFK_DIFF_LINES'] = bad;
        const flush = formatDiffBlock(diff, 'flush', '').map(stripAnsi);
        // Default cap of 30 should apply.
        expect(flush).toHaveLength(1 + 1 + FLUSH_DIFF_LINES_DEFAULT + 1);
      }
    } finally {
      if (original === undefined) delete process.env['AFK_DIFF_LINES'];
      else process.env['AFK_DIFF_LINES'] = original;
    }
  });

  it('flush footer names AFK_DIFF_LINES=0; overlay footer is the short form', () => {
    // Same diff, both modes — verify the discoverability hint only appears
    // in flush. Overlay footer should NOT mention the env var because the
    // overlay cap isn't user-tunable.
    const lines: { kind: ' ' | '+' | '-'; text: string }[] = Array.from(
      { length: 50 },
      (_, i) => ({ kind: '+' as const, text: `added ${i}` }),
    );
    const diff: DiffPayload = {
      addedLines: 50,
      removedLines: 0,
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 50, lines }],
    };
    const overlay = formatDiffBlock(diff, 'overlay', '').map(stripAnsi);
    const flush = formatDiffBlock(diff, 'flush', '').map(stripAnsi);
    expect(overlay[overlay.length - 1]).not.toContain('AFK_DIFF_LINES');
    expect(flush[flush.length - 1]).toContain('AFK_DIFF_LINES=0 to expand');
  });

  it('returns empty array when AFK_SHOW_DIFFS=0 (opt-out)', () => {
    const original = process.env['AFK_SHOW_DIFFS'];
    process.env['AFK_SHOW_DIFFS'] = '0';
    try {
      const lines = formatDiffBlock(makeDiff(), 'flush', '  ');
      expect(lines).toHaveLength(0);
    } finally {
      if (original === undefined) delete process.env['AFK_SHOW_DIFFS'];
      else process.env['AFK_SHOW_DIFFS'] = original;
    }
  });

  it('respects various falsy values for AFK_SHOW_DIFFS', () => {
    const original = process.env['AFK_SHOW_DIFFS'];
    try {
      for (const val of ['0', 'false', 'no', 'off', 'OFF', ' False ']) {
        process.env['AFK_SHOW_DIFFS'] = val;
        expect(formatDiffBlock(makeDiff(), 'flush', '')).toHaveLength(0);
      }
      // Truthy / unrecognized values keep diffs enabled.
      for (const val of ['1', 'true', 'on', 'yes', '']) {
        process.env['AFK_SHOW_DIFFS'] = val;
        expect(formatDiffBlock(makeDiff(), 'flush', '').length).toBeGreaterThan(0);
      }
    } finally {
      if (original === undefined) delete process.env['AFK_SHOW_DIFFS'];
      else process.env['AFK_SHOW_DIFFS'] = original;
    }
  });

  it('handles multi-hunk diffs with one header per hunk', () => {
    const diff: DiffPayload = {
      addedLines: 2,
      removedLines: 0,
      hunks: [
        {
          oldStart: 1, oldLines: 0, newStart: 1, newLines: 1,
          lines: [{ kind: '+', text: 'A' }],
        },
        {
          oldStart: 10, oldLines: 0, newStart: 11, newLines: 1,
          lines: [{ kind: '+', text: 'B' }],
        },
      ],
    };
    const lines = formatDiffBlock(diff, 'flush', '').map(stripAnsi);
    const headers = lines.filter((l) => l.startsWith('@@'));
    expect(headers).toHaveLength(2);
  });

  it('S1: scrubs OSC 8 hyperlinks and bare BEL from adversarial file content', () => {
    // A file containing an OSC 8 hyperlink + a bare BEL byte. Previously,
    // stripAnsi did not match `ESC]…` so the entire sequence (including
    // the BEL terminator) passed through to the terminal, ringing the bell
    // and injecting a clickable hyperlink span into the diff render.
    const oscHyperlink = '\x1b]8;;http://evil.example.com\x07click\x1b]8;;\x07';
    const bareBel = 'noisy\x07line';
    const diff: DiffPayload = {
      addedLines: 2,
      removedLines: 0,
      hunks: [{
        oldStart: 1, oldLines: 0, newStart: 1, newLines: 2,
        lines: [
          { kind: '+', text: oscHyperlink },
          { kind: '+', text: bareBel },
        ],
      }],
    };
    const lines = formatDiffBlock(diff, 'flush', '');
    const stripped = lines.map(stripAnsi).join('\n');
    // No raw ESC bytes survive — sanitized by stripAnsi.
    expect(stripped).not.toMatch(/\x1B/);
    // No raw BEL (0x07) survives — sanitized by the C0-control scrub.
    expect(stripped).not.toMatch(/\x07/);
    // The visible label inside the hyperlink should still be rendered.
    expect(stripped).toContain('click');
    // The bare-BEL line keeps its visible halves but loses the BEL.
    expect(stripped).toContain('noisyline');
  });

  it('S1: scrubs DCS / window-title (OSC ST) sequences from file content', () => {
    const dcs = 'a\x1bPdevice-control-payload\x1b\\b';
    const titleSet = 'c\x1b]0;PWNED\x1b\\d';
    const diff: DiffPayload = {
      addedLines: 2,
      removedLines: 0,
      hunks: [{
        oldStart: 1, oldLines: 0, newStart: 1, newLines: 2,
        lines: [
          { kind: '+', text: dcs },
          { kind: '+', text: titleSet },
        ],
      }],
    };
    const lines = formatDiffBlock(diff, 'flush', '');
    const stripped = lines.map(stripAnsi).join('\n');
    expect(stripped).not.toMatch(/\x1B/);
    expect(stripped).not.toContain('device-control-payload');
    expect(stripped).not.toContain('PWNED');
    expect(stripped).toContain('ab');
    expect(stripped).toContain('cd');
  });

  it('F10: strips ANSI escapes already present in file content (colorDiffLine)', () => {
    // A file whose line already contains an ANSI escape sequence (e.g. a
    // generated log fixture or a file with embedded color codes).
    const ansiRed = '\x1B[31m';
    const ansiReset = '\x1B[0m';
    const diff: DiffPayload = {
      addedLines: 1,
      removedLines: 0,
      hunks: [{
        oldStart: 1, oldLines: 0, newStart: 1, newLines: 1,
        lines: [{ kind: '+', text: `${ansiRed}colored content${ansiReset}` }],
      }],
    };
    const lines = formatDiffBlock(diff, 'flush', '');
    // After stripping ALL ANSI (palette + pre-existing), the raw content
    // should appear without any escape sequences.
    const stripped = lines.map(stripAnsi).join('\n');
    expect(stripped).not.toMatch(/\x1B/);
    // The visible text content should still appear.
    expect(stripped).toContain('colored content');
  });
});

/**
 * Sanitizer-suite L1 coverage. Both sanitizers must scrub the same byte
 * ranges (ANSI ESC sequences + C0 + C1 + DEL) — the difference is whether
 * they trim/collapse whitespace afterward. These tests pin the contracts of
 * each (single-line label vs. multi-line paragraph), so the two variants
 * cannot silently converge on the same shape later.
 */
describe('sanitizeLabel — single-line LLM-controlled label sanitizer', () => {
  it('strips ANSI CSI sequences (color codes)', () => {
    const input = '\x1b[31mred\x1b[0m';
    expect(sanitizeLabel(input)).toBe('red');
  });

  it('strips ANSI OSC sequences (terminal title / hyperlinks)', () => {
    // OSC 0 ; title BEL — would set the terminal window title.
    const input = '\x1b]0;malicious title\x07visible';
    expect(sanitizeLabel(input)).toBe('visible');
  });

  it('replaces bare BEL with a space and trims', () => {
    expect(sanitizeLabel('hello\x07world')).toBe('hello world');
    expect(sanitizeLabel('\x07trailing')).toBe('trailing');
  });

  it('replaces backspace (0x08) and DEL (0x7F) with spaces', () => {
    expect(sanitizeLabel('a\x08b\x7fc')).toBe('a b c');
  });

  it('collapses CR+LF into a single space and trims', () => {
    expect(sanitizeLabel('line1\r\nline2')).toBe('line1 line2');
    expect(sanitizeLabel('line1\n\nline2')).toBe('line1 line2');
  });

  it('strips C1 control range (U+0080–U+009F)', () => {
    // U+009B is the C1 CSI introducer — some 8-bit-mode terminals
    // interpret its UTF-8 wire bytes (0xC2 0x9B) as a CSI start.
    const input = 'before\u009Bafter';
    expect(sanitizeLabel(input)).toBe('before after');
  });

  it('collapses multi-space runs to a single space', () => {
    expect(sanitizeLabel('a    b')).toBe('a b');
  });

  it('trims leading and trailing whitespace', () => {
    expect(sanitizeLabel('   padded   ')).toBe('padded');
  });

  it('returns input unchanged when no control bytes present', () => {
    expect(sanitizeLabel('plain text')).toBe('plain text');
  });

  it('preserves TAB in single-line input (not a control byte target)', () => {
    // TAB is 0x09 — caught by CONTROL_CHAR_LABEL_RE (0x00–0x1F) and replaced
    // with a space. Pins that the regex range includes TAB for label
    // contexts (multi-tab indentation would otherwise survive into single-
    // line label slots where it widens unpredictably).
    expect(sanitizeLabel('a\tb')).toBe('a b');
  });
});

describe('sanitizeTextParagraph — multi-line LLM-controlled paragraph sanitizer', () => {
  it('strips ANSI CSI sequences (color codes)', () => {
    expect(sanitizeTextParagraph('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('replaces bare BEL with a space but does NOT trim', () => {
    expect(sanitizeTextParagraph('hello\x07world')).toBe('hello world');
    // Critical contract — leading control byte becomes leading space (NOT trimmed).
    expect(sanitizeTextParagraph('\x07trailing')).toBe(' trailing');
  });

  it('preserves leading indentation (markdown list bullets)', () => {
    // The bug M2 fixed: sanitizeLabel would have flattened "  - item" to
    // "- item" by trimming + collapsing the two leading spaces. The
    // paragraph variant must leave list indentation intact for the wrap
    // path to render it correctly.
    expect(sanitizeTextParagraph('  - item one')).toBe('  - item one');
    expect(sanitizeTextParagraph('    nested')).toBe('    nested');
  });

  it('does NOT collapse multi-space runs', () => {
    expect(sanitizeTextParagraph('a    b')).toBe('a    b');
  });

  it('does NOT trim trailing whitespace', () => {
    expect(sanitizeTextParagraph('text   ')).toBe('text   ');
  });

  it('strips C1 control range (U+0080–U+009F)', () => {
    expect(sanitizeTextParagraph('before\u009Bafter')).toBe('before after');
  });

  it('strips DEL (0x7F)', () => {
    expect(sanitizeTextParagraph('a\x7fb')).toBe('a b');
  });

  it('returns input unchanged when no control bytes present', () => {
    expect(sanitizeTextParagraph('  indented text  ')).toBe('  indented text  ');
  });
});
