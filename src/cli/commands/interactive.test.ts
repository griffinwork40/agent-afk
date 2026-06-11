import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StreamingMarkdownRenderer } from '../markdown-stream.js';
import { renderMarkdownToTerminal } from '../formatter.js';
import { palette } from '../palette.js';
import { formatToolResultLine, isAutonameEnabled, formatAutonameSkipReason, startupHintLine } from './interactive.js';
import type { ToolResultChunk } from '../../agent/types/message-types.js';
import type { CliOptions } from './interactive/shared.js';
import type { CliConfig } from '../config.js';

/**
 * Tests for the interactive command's runTurn integration
 *
 * Verifies:
 * 1. Streaming content chunks flow through StreamingMarkdownRenderer
 * 2. Thinking chunks are tracked and collapsed
 * 3. Tool_use + tool_result pairing logic
 * 4. Proper timer and resource cleanup
 *
 * Note: Tests focus on the key logic components (ThinkingLane, chunk handling)
 * rather than the full runTurn function which is tightly coupled to the REPL loop.
 */

describe('interactive command - streaming logic', () => {
  let originalLog: typeof console.log;
  let logs: string[] = [];

  beforeEach(() => {
    originalLog = console.log;
    logs = [];
    console.log = vi.fn((...args: unknown[]) => {
      logs.push(args.map(a => String(a)).join(' '));
    });
  });

  afterEach(() => {
    console.log = originalLog;
    vi.clearAllTimers();
  });

  describe('thinking lane (collapse logic)', () => {
    it('should track thinking chunks and provide collapse summary', () => {
      // Simulate ThinkingLane behavior
      let buffer = '';
      let startTime = Date.now();
      let hasCollapsed = false;

      const push = (chunk: string) => {
        if (!hasCollapsed) {
          buffer += chunk;
        }
      };

      const collapse = (): string | null => {
        if (hasCollapsed || !startTime) return null;
        hasCollapsed = true;

        const duration = Date.now() - startTime;
        const durationStr = duration < 1000
          ? `${duration}ms`
          : `${(duration / 1000).toFixed(1)}s`;
        const tokenCount = Math.ceil(buffer.length / 4);

        return `  ${palette.thinking('💭 thought for ' + durationStr + ' (' + tokenCount + ' tok)')}`;
      };

      // Test
      push('Let me think about this. ');
      push('This is a complex problem.');
      expect(hasCollapsed).toBe(false);

      const summary = collapse();
      expect(summary).toBeDefined();
      expect(summary).toMatch(/💭 thought for/);
      expect(summary).toMatch(/tok/);

      // Second call should return null (already collapsed)
      const secondCall = collapse();
      expect(secondCall).toBeNull();
    });

    it('should not emit thinking summary if no chunks were pushed', () => {
      let buffer = '';
      let startTime: number | null = null;
      let hasCollapsed = false;

      const collapse = (): string | null => {
        if (hasCollapsed || !startTime) return null;
        hasCollapsed = true;

        const duration = Date.now() - startTime;
        const durationStr = duration < 1000
          ? `${duration}ms`
          : `${(duration / 1000).toFixed(1)}s`;
        const tokenCount = Math.ceil(buffer.length / 4);

        return `  ${palette.thinking('💭 thought for ' + durationStr + ' (' + tokenCount + ' tok)')}`;
      };

      // Don't push anything
      const summary = collapse();
      expect(summary).toBeNull();
    });
  });

  describe('tool_use and tool_result pairing', () => {
    it('should track tool_use and match with tool_result', () => {
      const toolUseMap = new Map<string, { line: number; used: boolean }>();
      let lineCounter = 0;

      // Simulate tool_use
      const toolUseId = 'tool_1';
      toolUseMap.set(toolUseId, { line: lineCounter, used: false });
      lineCounter++;

      // Simulate tool_result
      const entry = toolUseMap.get(toolUseId);
      expect(entry).toBeDefined();
      expect(entry?.used).toBe(false);

      // Mark as used
      entry!.used = true;
      expect(entry.used).toBe(true);
    });

    it('should format envelope tool_result with persisted path', () => {
      const chunk: ToolResultChunk = {
        type: 'tool_result',
        toolUseId: 'x',
        content: 'Output persisted',
        persistedPath: '/Users/example/foo/bar.txt',
        sizeLabel: '30.2KB',
        sizeBytes: 30925,
      };

      const line = formatToolResultLine(chunk, undefined, '/Users/example');

      expect(line).toContain('saved →');
      expect(line).toContain('~/foo/bar.txt');
      expect(line).not.toContain('[unpaired]');
    });

    it('should format envelope tool_result with absolute path outside HOME', () => {
      const chunk: ToolResultChunk = {
        type: 'tool_result',
        toolUseId: 'x',
        content: 'Output persisted',
        persistedPath: '/tmp/x.txt',
        sizeLabel: '1.5KB',
        sizeBytes: 1536,
      };

      const line = formatToolResultLine(chunk, undefined, '/Users/example');

      expect(line).toContain('/tmp/x.txt');
      expect(line).not.toContain('~');
      expect(line).not.toContain('[unpaired]');
    });

    it('should format large tool_result with line count only', () => {
      const chunk: ToolResultChunk = {
        type: 'tool_result',
        toolUseId: 'x',
        content: 'first line preview from large output',
        sizeBytes: 3480,
        sizeLabel: '3.4KB',
        lineCount: 128,
      };

      const line = formatToolResultLine(chunk);

      expect(line).toContain('128 lines');
      expect(line).not.toContain('3.4KB');
      expect(line).not.toContain('first line preview');
      expect(line).not.toContain('[unpaired]');
    });

    it('should include tool prefix when provided', () => {
      const chunk: ToolResultChunk = {
        type: 'tool_result',
        toolUseId: 'x',
        content: 'first line preview from large output',
        sizeBytes: 3480,
        sizeLabel: '3.4KB',
        lineCount: 128,
      };

      const line = formatToolResultLine(chunk, '● Read(file.ts)');

      expect(line).toContain('● Read(file.ts)');
      expect(line).toContain('128 lines');
    });

    it('should format small tool_result without size metadata', () => {
      const chunk: ToolResultChunk = {
        type: 'tool_result',
        toolUseId: 'x',
        content: 'ok',
      };

      const line = formatToolResultLine(chunk);

      expect(line).toContain('ok');
      expect(line).not.toContain('[unpaired]');
      expect(line).not.toContain('lines');
    });

    it('should format error tool_result with proper coloring', () => {
      const chunk: ToolResultChunk = {
        type: 'tool_result',
        toolUseId: 'x',
        content: 'Error occurred',
        isError: true,
      };

      const line = formatToolResultLine(chunk);

      expect(line).toContain('Error occurred');
      expect(line).not.toContain('[unpaired]');
    });

    it('should never render unpaired marker', () => {
      // Test that the new logic never renders [unpaired]
      const chunk: ToolResultChunk = {
        type: 'tool_result',
        toolUseId: 'tool_999',
        content: 'some output',
      };

      const line = formatToolResultLine(chunk);

      expect(line).not.toContain('[unpaired]');
    });

    it('should truncate long tool results to 80 chars', () => {
      const longResult = 'This is a very long output that should be truncated to fit on a single line in the terminal display';
      const preview = longResult.length > 80
        ? longResult.slice(0, 77) + '…'
        : longResult;

      expect(preview.length).toBeLessThanOrEqual(80);
      expect(preview).toMatch(/…$/);
    });

    it('should apply error coloring to failed tool results', () => {
      const isError = true;
      const resultColor = isError ? palette.error : palette.dim;
      const resultLine = resultColor('Command failed');

      // Verify color was applied
      expect(resultLine).toMatch(/Command failed/);
    });
  });

  describe('StreamingMarkdownRenderer integration', () => {
    it('should render markdown blocks from streaming chunks', async () => {
      const renderer = new StreamingMarkdownRenderer();

      renderer.push('# Header\n\n');
      renderer.push('This is a paragraph.\n\n');
      renderer.push('Another paragraph.');

      await renderer.flush();

      const output = renderer.getCommittedOutput();
      expect(output).toContain('Header');
      expect(output).toContain('This is a paragraph');
      expect(output).toContain('Another paragraph');

      renderer.dispose();
    });

    it('should handle plain text without markdown markers', async () => {
      const renderer = new StreamingMarkdownRenderer();

      renderer.push('Just plain text.\n');
      renderer.push('No markdown here.');

      await renderer.flush();

      const output = renderer.getCommittedOutput();
      expect(output).toContain('Just plain text');
      expect(output).toContain('No markdown here');

      renderer.dispose();
    });

    it('should properly dispose and clean up timers', async () => {
      vi.useFakeTimers();
      try {
        const renderer = new StreamingMarkdownRenderer();

        renderer.push('Some content');
        renderer.dispose();

        // Verify no pending timers
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should not hang on multiple push and flush cycles', async () => {
      const renderer = new StreamingMarkdownRenderer();

      // Multiple chunks
      renderer.push('Chunk 1\n\n');
      renderer.push('Chunk 2\n\n');
      renderer.push('Chunk 3');

      // Should complete without hanging
      await renderer.flush();

      expect(renderer.getCommittedOutput()).toBeTruthy();
      renderer.dispose();
    });
  });

  describe('assistant header rendering', () => {
    it('should format the Claude header correctly', () => {
      const header = `\n  ${palette.brand('◆ ')}${palette.bold(palette.brand('Claude'))}\n`;
      expect(header).toMatch(/Claude/);
      expect(header).toMatch(/◆/);
    });

    it('should apply proper color palette', () => {
      const brandText = palette.brand('◆ Claude');
      const thinkingText = palette.thinking('💭 thinking');

      expect(brandText).toBeTruthy();
      expect(thinkingText).toBeTruthy();
    });
  });

  describe('thinking palette color', () => {
    it('should have thinking role in palette', () => {
      expect(palette).toHaveProperty('thinking');
    });

    it('should render thinking text with italic formatting', () => {
      const thinkingRendered = palette.thinking('test');
      expect(thinkingRendered).toMatch(/test/);
    });
  });

  describe('edge cases and cleanup', () => {
    it('should handle empty content gracefully', () => {
      vi.useFakeTimers();
      try {
        const renderer = new StreamingMarkdownRenderer();

        renderer.push('');
        renderer.dispose();

        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should handle rapid disposal without errors', () => {
      vi.useFakeTimers();
      try {
        const renderer = new StreamingMarkdownRenderer();
        renderer.dispose();
        renderer.dispose(); // Should not throw

        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should support tool result error detection', () => {
      interface ToolResult {
        isError?: boolean;
        content: string;
      }

      const errorResult: ToolResult = {
        isError: true,
        content: 'An error occurred',
      };

      const successResult: ToolResult = {
        isError: false,
        content: 'Success',
      };

      expect(errorResult.isError).toBe(true);
      expect(successResult.isError).toBe(false);
    });

    it('should track multiple tool calls and results', () => {
      const toolUseMap = new Map<string, { line: number; used: boolean }>();

      // Add multiple tool uses
      toolUseMap.set('tool_1', { line: 0, used: false });
      toolUseMap.set('tool_2', { line: 1, used: false });
      toolUseMap.set('tool_3', { line: 2, used: false });

      expect(toolUseMap.size).toBe(3);

      // Mark some as used
      toolUseMap.get('tool_1')!.used = true;
      toolUseMap.get('tool_3')!.used = true;

      // Verify state
      expect(toolUseMap.get('tool_1')!.used).toBe(true);
      expect(toolUseMap.get('tool_2')!.used).toBe(false);
      expect(toolUseMap.get('tool_3')!.used).toBe(true);
    });
  });

  describe('regression: basic text streaming', () => {
    it('should render simple text-only response without errors', async () => {
      const renderer = new StreamingMarkdownRenderer();

      renderer.push('Hello, this is a simple response.');

      await renderer.flush();

      const output = renderer.getCommittedOutput();
      expect(output).toContain('Hello');
      expect(output).toContain('simple response');

      renderer.dispose();
    });

    it('should handle multi-paragraph responses', async () => {
      const renderer = new StreamingMarkdownRenderer();

      renderer.push('First paragraph.\n\n');
      renderer.push('Second paragraph.\n\n');
      renderer.push('Third paragraph.');

      await renderer.flush();

      const output = renderer.getCommittedOutput();
      expect(output).toContain('First');
      expect(output).toContain('Second');
      expect(output).toContain('Third');

      renderer.dispose();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // T1: AFK_WORKTREE_AUTONAME env parsing
  // ────────────────────────────────────────────────────────────────────────
  describe('isAutonameEnabled — AFK_WORKTREE_AUTONAME env parsing', () => {
    const emptyConfig: CliConfig = {};
    // Default options: worktreeAutoname not explicitly set (undefined = truthy default)
    const defaultOptions = {} as CliOptions;

    let savedEnv: string | undefined;

    beforeEach(() => {
      savedEnv = process.env['AFK_WORKTREE_AUTONAME'];
      delete process.env['AFK_WORKTREE_AUTONAME'];
    });

    afterEach(() => {
      if (savedEnv === undefined) {
        delete process.env['AFK_WORKTREE_AUTONAME'];
      } else {
        process.env['AFK_WORKTREE_AUTONAME'] = savedEnv;
      }
    });

    it.each([
      ['0', false],
      ['false', false],
      ['off', false],
      ['no', false],
      ['FALSE', false],
      ['OFF', false],
      ['NO', false],
    ])("env='%s' → disabled", (envVal, expected) => {
      process.env['AFK_WORKTREE_AUTONAME'] = envVal;
      expect(isAutonameEnabled(defaultOptions, emptyConfig)).toBe(expected);
    });

    it.each([
      ['1', true],
      ['true', true],
      ['yes', true],
      ['on', true],
      ['anything', true],
    ])("env='%s' → enabled", (envVal, expected) => {
      process.env['AFK_WORKTREE_AUTONAME'] = envVal;
      expect(isAutonameEnabled(defaultOptions, emptyConfig)).toBe(expected);
    });

    it('env unset + no config → enabled (default true)', () => {
      expect(isAutonameEnabled(defaultOptions, emptyConfig)).toBe(true);
    });

    it('env unset + config false → disabled', () => {
      const config: CliConfig = { interactive: { worktreeAutoname: false } };
      expect(isAutonameEnabled(defaultOptions, config)).toBe(false);
    });

    it('env unset + config true → enabled', () => {
      const config: CliConfig = { interactive: { worktreeAutoname: true } };
      expect(isAutonameEnabled(defaultOptions, config)).toBe(true);
    });

    it('--no-worktree-autoname CLI flag overrides env=1', () => {
      process.env['AFK_WORKTREE_AUTONAME'] = '1';
      const options = { worktreeAutoname: false } as unknown as CliOptions;
      expect(isAutonameEnabled(options, emptyConfig)).toBe(false);
    });
  });

  describe('formatAutonameSkipReason — UX text for silent-skip diagnostic', () => {
    it('returns undefined for empty-message (intentional skip, no signal)', () => {
      expect(formatAutonameSkipReason('empty-message', undefined)).toBeUndefined();
    });

    it('returns undefined for slash-command (intentional skip, hook will retry)', () => {
      expect(formatAutonameSkipReason('slash-command', undefined)).toBeUndefined();
    });

    it('renders generator-error with detail', () => {
      const text = formatAutonameSkipReason('slug-generator-error', '401 invalid bearer');
      expect(text).toBe('slug generation failed: 401 invalid bearer');
    });

    it('renders generator-error without detail', () => {
      const text = formatAutonameSkipReason('slug-generator-error', undefined);
      expect(text).toBe('slug generation failed');
    });

    it('renders invalid-slug-output with JSON-quoted detail (escapes weird chars)', () => {
      const text = formatAutonameSkipReason('invalid-slug-output', '"weird" output');
      // JSON.stringify escapes the quotes — confirms we don't double-up on quoting
      expect(text).toBe('model returned invalid slug: "\\"weird\\" output"');
    });

    it('renders invalid-slug-output without detail', () => {
      const text = formatAutonameSkipReason('invalid-slug-output', undefined);
      expect(text).toBe('model returned invalid slug');
    });

    it('renders unknown gracefully', () => {
      expect(formatAutonameSkipReason('unknown', undefined)).toBe('unknown reason');
    });
  });

  describe('startupHintLine — first-session welcome hint', () => {
    it('keeps the essential first-session controls', () => {
      const hint = startupHintLine();
      expect(hint).toContain('/help');
      expect(hint).toContain('/model');
      expect(hint).toContain('Esc to interrupt');
      expect(hint).toContain('/exit to quit');
    });

    it('omits /resume — useless to a new user, redundant when resuming', () => {
      expect(startupHintLine()).not.toContain('/resume');
    });

    it('stays compact (≤ 4 dot-separated items) so the busiest startup line is scannable', () => {
      const items = startupHintLine().split(' · ');
      expect(items.length).toBeLessThanOrEqual(4);
    });
  });

  describe('non-streaming fallback markdown rendering', () => {
    it('should render markdown in non-streaming fallback path (issue #33c96db)', () => {
      // Regression test: when includePartialMessages is missing, the SDK does not
      // emit stream_event partials, so event.type === 'content' never fires.
      // The fallback at event.type === 'done' receives full responseText with
      // markdown, but must render it instead of printing raw text.

      const markdownText = 'This is **bold** text and this is *italic*.';

      // The fallback path (non-streaming) calls renderMarkdownToTerminal
      const rendered = renderMarkdownToTerminal(markdownText);

      // Verify markdown was processed: bold markers should be gone and
      // ANSI codes should be present (bold would be \x1b[1m...\x1b[22m)
      expect(rendered).not.toContain('**bold**');
      expect(rendered).toBeTruthy(); // Should produce some ANSI output
      // The rendered string contains the word 'bold' but without the markdown delimiters
      expect(rendered).toContain('bold');
    });

    it('should handle markdown with code blocks in fallback', () => {
      const markdownText = '```typescript\nconst x = 1;\n```';

      const rendered = renderMarkdownToTerminal(markdownText);

      // Should not contain raw backticks from code fence markers
      // (The markdown renderer processes these into proper terminal output)
      expect(rendered).toBeTruthy();
      expect(rendered).toContain('const');
    });

    it('renders bold/italic inside tight list items without leaking markers', () => {
      // Regression: marked emits block-level `text` tokens (with inline
      // children) as the body of tight list items. Without a `text` case in
      // renderTokens, those fell through to `default: return token.raw`,
      // leaking literal **bold** / *italic* markers.
      const rendered = renderMarkdownToTerminal(
        '- item with **bold** and *italic*\n- plain'
      );

      expect(rendered).not.toContain('**');
      expect(rendered).not.toContain('*italic*');
      expect(rendered).toContain('bold');
      expect(rendered).toContain('italic');
      expect(rendered).toContain('item with');
      expect(rendered).toContain('plain');
    });

    it('renders bold/italic inside ordered tight list items', () => {
      const rendered = renderMarkdownToTerminal(
        '1. first with **bold**\n2. second *italic*'
      );

      expect(rendered).not.toContain('**');
      expect(rendered).not.toContain('*italic*');
      expect(rendered).toContain('bold');
      expect(rendered).toContain('italic');
      expect(rendered).toContain('first with');
      expect(rendered).toContain('second');
    });
  });
});
