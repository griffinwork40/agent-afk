/**
 * Smoke-level test for the interactive REPL's progress-banner rendering.
 *
 * Rather than booting the full REPL (which wires readline, spinners, status
 * lines, and live SDK streams), this test validates the rendering shape
 * produced from a synthetic progress event. The assertions are on the
 * visible CLI text — palette ANSI codes are stripped via a simple regex so
 * the expectations read naturally.
 *
 * The visible invariants that must hold:
 *   - `◦` progress glyph
 *   - the event's `description`
 *   - a parenthesized stats tail with `lastToolName`, tool-use count,
 *     token estimate, and duration
 *   - a separate indented `summary` line when the summary is present
 *
 * If this test breaks, the REPL's inline contract for progress display has
 * regressed and the Telegram forwarder likely needs re-checking too.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import chalk from 'chalk';
import {
  formatProgressBanner,
  formatProgressSummary,
} from './commands/interactive/progress-banner.js';
import type { ProgressEvent } from '../agent/types.js';

const STRIP_ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(STRIP_ANSI, '');

let originalChalkLevel: typeof chalk.level;
beforeAll(() => {
  originalChalkLevel = chalk.level;
  chalk.level = 3;
});
afterAll(() => {
  chalk.level = originalChalkLevel;
});

describe('interactive REPL — progress banner rendering', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  const captured: string[] = [];

  beforeEach(() => {
    captured.length = 0;
    consoleSpy = vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      captured.push(typeof msg === 'string' ? msg.replace(STRIP_ANSI, '') : String(msg));
    });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('renders ◦ description with a parenthesized stats tail', () => {
    const lines = formatProgressBanner({
      taskId: 't1',
      description: 'Researching codebase',
      lastToolName: 'Grep',
      totalTokens: 1200,
      toolUses: 3,
      durationMs: 4500,
    });
    const joined = strip(lines.join('\n'));
    expect(joined).toMatch(/◦ Researching codebase/);
    // `via {glyph} {ToolName}` — Grep is read-category (● glyph)
    expect(joined).toContain('via ● Grep');
    expect(joined).toContain('3 tool calls');
    expect(joined).toContain('1.2k tok');
    expect(joined).toContain('5s');
  });

  it('renders a separate summary line when summary is provided', () => {
    const lines = formatProgressBanner({
      taskId: 't1',
      description: 'Compiling results',
      summary: '42 matches across 8 files',
      totalTokens: 0,
      toolUses: 0,
      durationMs: 0,
    });
    expect(lines).toHaveLength(2);
    expect(strip(lines[0]!)).toContain('◦ Compiling results');
    expect(strip(lines[1]!)).toContain('42 matches across 8 files');
  });

  it('always shows the hint even when no numeric stats are available', () => {
    const lines = formatProgressBanner({
      taskId: 't1',
      description: 'Starting',
      totalTokens: 0,
      toolUses: 0,
      durationMs: 0,
    });
    expect(strip(lines[0]!)).toContain('esc to interrupt · ctrl+b background');
    expect(lines).toHaveLength(1);
  });

  it('uses singular tool form for a single tool use', () => {
    const lines = formatProgressBanner({
      taskId: 't1',
      description: 'One call',
      toolUses: 1,
      totalTokens: 0,
      durationMs: 0,
    });
    expect(strip(lines[0]!)).toContain('1 tool');
    expect(strip(lines[0]!)).not.toContain('1 tools');
  });

  it('hint is always present regardless of whether numeric stats exist', () => {
    const lines = formatProgressBanner({
      taskId: 't1',
      description: 'Empty stats',
      totalTokens: 0,
      toolUses: 0,
      durationMs: 0,
    });
    expect(strip(lines[0]!)).toContain('esc to interrupt · ctrl+b background');
  });

  it('hint trails all numeric stats', () => {
    const lines = formatProgressBanner({
      taskId: 't1',
      description: 'Working',
      totalTokens: 1000,
      toolUses: 2,
      durationMs: 3000,
    });
    const text = strip(lines.join('\n'));
    const tokenIdx = text.indexOf('1k tok');
    const hintIdx = text.indexOf('esc to interrupt');
    expect(tokenIdx).toBeGreaterThan(-1);
    expect(hintIdx).toBeGreaterThan(tokenIdx);
  });

  it('places stats on the summary line when a summary is present', () => {
    const lines = formatProgressBanner({
      taskId: 't1',
      description: 'Dispatching worker',
      summary: 'Reading package.json',
      lastToolName: 'Read',
      toolUses: 2,
      totalTokens: 500,
      durationMs: 1500,
    });
    expect(lines).toHaveLength(2);
    expect(strip(lines[0]!)).toBe('  ◦ Dispatching worker');
    expect(strip(lines[1]!)).toContain('Reading package.json');
    // Read is read-category (● glyph)
    expect(strip(lines[1]!)).toContain('via ● Read');
    expect(strip(lines[1]!)).toContain('2 tool calls');
  });

  it('colorizes the via segment by tool category and uses a category-specific glyph', () => {
    const cases: Array<{ tool: string; glyph: string }> = [
      { tool: 'Read', glyph: '●' },        // read
      { tool: 'Bash', glyph: '$' },        // shell
      { tool: 'Agent', glyph: '→' },       // subagent
      { tool: 'mcp__github__create_issue', glyph: '⊡' }, // mcp
    ];
    const renderedRawByTool = new Map<string, string>();
    for (const { tool, glyph } of cases) {
      const lines = formatProgressBanner({
        taskId: 't1',
        description: 'Working',
        lastToolName: tool,
        totalTokens: 0,
        toolUses: 0,
        durationMs: 0,
      });
      const raw = lines.join('\n');
      renderedRawByTool.set(tool, raw);
      // Stripped: visible glyph + name appear together
      expect(strip(raw)).toContain(`via ${glyph} ${tool}`);
      // Raw: an ANSI escape sits between `via ` and the glyph — proving the
      // segment is colored (not just plain text wrapped in dim).
      const glyphIdx = raw.indexOf(glyph);
      expect(glyphIdx).toBeGreaterThan(0);
      const beforeGlyph = raw.slice(0, glyphIdx);
      expect(beforeGlyph).toMatch(/via \x1b\[/);
    }
    // Different tool categories must produce different raw output (different
    // colors → different ANSI bytes), even when the visible text length
    // happens to match.
    const renderings = [...renderedRawByTool.values()];
    expect(new Set(renderings).size).toBe(renderings.length);
  });
});

describe('formatProgressSummary — one-line summary committed on task completion', () => {
  const mkEvent = (overrides: Partial<ProgressEvent> & { taskId: string; description: string }): ProgressEvent => ({
    totalTokens: 0,
    toolUses: 0,
    durationMs: 0,
    ...overrides,
  });

  it('renders description with stats on a single dim line', () => {
    const event = mkEvent({
      taskId: 't1',
      description: 'Researching codebase',
      toolUses: 7,
      totalTokens: 12000,
      durationMs: 15000,
    });
    const line = strip(formatProgressSummary(event));
    expect(line).toMatch(/◦ Researching codebase/);
    expect(line).toContain('7 tool calls');
    expect(line).toContain('12k tok');
    expect(line).toContain('15s');
  });

  it('omits stats tail when no stats are available', () => {
    const event = mkEvent({ taskId: 't1', description: 'Starting' });
    const line = strip(formatProgressSummary(event));
    expect(line).toBe('  ◦ Starting');
  });

  it('uses singular tool form for a single tool use', () => {
    const event = mkEvent({ taskId: 't1', description: 'Quick check', toolUses: 1 });
    const line = strip(formatProgressSummary(event));
    expect(line).toContain('1 tool call)');
    expect(line).not.toContain('1 tools');
  });

  it('does not include lastToolName (banner-only detail)', () => {
    const event = mkEvent({
      taskId: 't1',
      description: 'Working',
      lastToolName: 'Read',
      toolUses: 3,
      totalTokens: 500,
      durationMs: 2000,
    });
    const line = strip(formatProgressSummary(event));
    expect(line).not.toContain('Read');
    expect(line).not.toContain('via');
    expect(line).toContain('3 tool calls');
  });
});
