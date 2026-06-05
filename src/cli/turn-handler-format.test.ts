/**
 * Tests for the tool-line formatter in turn-handler.ts.
 *
 * formatToolLine renders a tool_use chunk's `content` string into the
 * `{glyph} {ToolName}{args}` bullet that lands in the REPL scrollback.
 * Each tool category gets a distinct glyph + color so readers can tell at
 * a glance whether the agent is reading, writing, shelling, or
 * dispatching a sub-agent.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import chalk from 'chalk';
import { formatToolLine, ToolLane } from './commands/interactive/tool-lane.js';
import { formatProgressBanner } from './commands/interactive/progress-banner.js';
import type { ToolResultChunk } from '../agent/types/message-types.js';

const STRIP_ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(STRIP_ANSI, '');

describe('formatToolLine', () => {
  let originalLevel: typeof chalk.level;
  beforeAll(() => {
    originalLevel = chalk.level;
    chalk.level = 3;
  });
  afterAll(() => {
    chalk.level = originalLevel;
  });

  it.each([
    { content: 'Read(file.ts)', glyph: '●', name: 'Read' },
    { content: 'Write(out.txt)', glyph: '✎', name: 'Write' },
    { content: 'Bash(ls -la)', glyph: '$', name: 'Bash' },
    { content: 'Agent(research)', glyph: '→', name: 'Agent' },
    { content: 'Skill(/spec)', glyph: '◆', name: 'Skill' },
    { content: 'compose(3 nodes)', glyph: '⬡', name: 'compose' },
    { content: 'mcp__github__create_issue({title})', glyph: '⊡', name: 'mcp__github__create_issue' },
    { content: 'WebSearch(claude code)', glyph: '⌖', name: 'WebSearch' },
    { content: 'TaskCreate(...)', glyph: '▱', name: 'TaskCreate' },
    // snake_case agent-afk built-ins (src/agent/tools/schemas.ts)
    { content: 'read_file(file.ts)', glyph: '●', name: 'read_file' },
    { content: 'write_file(out.txt)', glyph: '✎', name: 'write_file' },
    { content: 'edit_file(f.ts)', glyph: '✎', name: 'edit_file' },
    { content: 'bash(ls)', glyph: '$', name: 'bash' },
    { content: 'list_directory(/tmp)', glyph: '●', name: 'list_directory' },
    { content: 'send_telegram(hi)', glyph: '⌖', name: 'send_telegram' },
  ])('renders $name with glyph $glyph', ({ content, glyph, name }) => {
    const out = formatToolLine(content);
    const stripped = strip(out);
    expect(stripped).toContain(`${glyph} ${name}`);
    // Args (everything after the name) should still be present.
    const args = content.slice(name.length);
    if (args.length > 0) {
      expect(stripped).toContain(args);
    }
    // The output should carry ANSI color codes when chalk is enabled.
    expect(out).toMatch(/\x1b\[/);
  });

  it.each([
    { content: 'Agent(research)', tag: '[subagent]' },
    { content: 'agent(research)', tag: '[subagent]' },
    { content: 'Task(verify)', tag: '[subagent]' },
    { content: 'Skill(/spec)', tag: '[skill]' },
    { content: 'skill(/spec)', tag: '[skill]' },
    { content: 'compose(3 nodes)', tag: '[dag]' },
    { content: 'Compose(...)', tag: '[dag]' },
  ])('appends dispatch tag $tag to $content', ({ content, tag }) => {
    const stripped = strip(formatToolLine(content));
    expect(stripped).toContain(tag);
  });

  it.each([
    { content: 'Read(file.ts)' },
    { content: 'Bash(ls)' },
    { content: 'WebSearch(q)' },
    { content: 'read_file(x.ts)' },
    { content: 'send_telegram(hi)' },
    { content: 'mcp__github__issue({})' },
  ])('does not append a dispatch tag to direct-action tool $content', ({ content }) => {
    const stripped = strip(formatToolLine(content));
    expect(stripped).not.toMatch(/\[(subagent|skill|dag)\]/);
  });

  it('falls back to a generic bullet for content without a leading identifier', () => {
    const out = formatToolLine('(some args without a name)');
    const stripped = strip(out);
    expect(stripped).toContain('● ');
    expect(stripped).toContain('(some args without a name)');
  });

  describe('compose argument summarization', () => {
    it('renders compose JSON input as `(N nodes, M edges)`', () => {
      const input = '{"nodes":[{"id":"a","prompt":"x"},{"id":"b","prompt":"y"},{"id":"c","prompt":"z"}],"edges":[{"from":"a","to":"b"},{"from":"b","to":"c"}]}';
      const stripped = strip(formatToolLine('compose' + input));
      expect(stripped).toContain('compose');
      expect(stripped).toContain('(3 nodes, 2 edges)');
      // Raw JSON keys must NOT leak through.
      expect(stripped).not.toContain('"nodes"');
      expect(stripped).not.toContain('"prompt"');
    });

    it('omits the edges clause when there are zero edges', () => {
      const input = '{"nodes":[{"id":"a","prompt":"x"}]}';
      const stripped = strip(formatToolLine('compose' + input));
      expect(stripped).toContain('(1 node)');
      expect(stripped).not.toContain('edge');
    });

    it('pluralizes node/edge counts correctly', () => {
      expect(strip(formatToolLine('compose{"nodes":[{"id":"a"}]}'))).toContain('(1 node)');
      expect(strip(formatToolLine('compose{"nodes":[{"id":"a"},{"id":"b"}]}'))).toContain('(2 nodes)');
      expect(strip(formatToolLine('compose{"nodes":[{"id":"a"},{"id":"b"}],"edges":[{"from":"a","to":"b"}]}'))).toContain('1 edge)');
    });

    it('accepts the `(...)`-wrapped form (orchestrator chunk path)', () => {
      const stripped = strip(formatToolLine('compose({"nodes":[{"id":"a"},{"id":"b"}]})'));
      expect(stripped).toContain('(2 nodes)');
    });

    it('falls open to the original args when JSON is malformed', () => {
      // Garbage input must NOT crash the formatter; just renders as-is.
      const stripped = strip(formatToolLine('compose(not json at all)'));
      expect(stripped).toContain('compose');
      // Original args preserved (no synthesized summary).
      expect(stripped).toContain('not json');
    });

    it('fails open when nodes key is missing (M4 — schema drift)', () => {
      // Valid JSON, no `nodes` key — must not crash and must not emit a synthesized count.
      const stripped = strip(formatToolLine('compose({"edges":[{"from":"a","to":"b"}]})'));
      expect(stripped).toContain('compose');
      expect(stripped).not.toMatch(/\d+ node/);
    });

    it('fails open when nodes is not an array (M4 — schema drift)', () => {
      // `nodes` is a string instead of an array — must not crash, must not emit a count.
      const stripped = strip(formatToolLine('compose({"nodes":"not-an-array"})'));
      expect(stripped).toContain('compose');
      expect(stripped).not.toMatch(/\d+ node/);
    });

    it('fails open when nodes is null (M4 — schema drift)', () => {
      // `nodes` is null — must not crash, must not emit a count.
      const stripped = strip(formatToolLine('compose({"nodes":null})'));
      expect(stripped).toContain('compose');
      expect(stripped).not.toMatch(/\d+ node/);
    });
  });

  it('preserves multi-line tool args (the regex captures the full tail with /s)', () => {
    const out = formatToolLine('Bash(echo hi\n  && echo bye)');
    const stripped = strip(out);
    expect(stripped).toContain('$ Bash');
    expect(stripped).toContain('echo bye');
  });

  it('shortens absolute paths with 3+ segments to basename', () => {
    const out = formatToolLine('Read(/Users/example/Projects/src/cli/tool-category.ts)');
    const stripped = strip(out);
    expect(stripped).toContain('tool-category.ts');
    expect(stripped).not.toContain('/Users/example');
  });

  it('preserves short paths with fewer than 3 segments', () => {
    const out = formatToolLine('Read(/tmp/file.ts)');
    const stripped = strip(out);
    expect(stripped).toContain('/tmp/file.ts');
  });

  it('shortens paths inside Bash args', () => {
    const out = formatToolLine('Bash(git -C /Users/example/Projects/agent-afk log)');
    const stripped = strip(out);
    expect(stripped).toContain('agent-afk log');
    expect(stripped).not.toContain('/Users/example');
  });
});

function makeResult(overrides: Partial<ToolResultChunk> = {}): ToolResultChunk {
  return {
    type: 'tool_result',
    toolUseId: 'tu_1',
    content: '',
    lineCount: 50,
    ...overrides,
  };
}

describe('ToolLane', () => {
  let originalLevel: typeof chalk.level;
  beforeAll(() => {
    originalLevel = chalk.level;
    chalk.level = 3;
  });
  afterAll(() => {
    chalk.level = originalLevel;
  });

  it('reports hasPending after addStart', () => {
    const lane = new ToolLane();
    expect(lane.hasPending()).toBe(false);
    lane.addStart('tu_1', 'Read', ' /tmp/file.ts');
    expect(lane.hasPending()).toBe(true);
  });

  it('getOverlay shows pending tools with ellipsis', () => {
    const lane = new ToolLane();
    lane.addStart('tu_1', 'Read', ' file.ts');
    const overlay = strip(lane.getOverlay());
    expect(overlay).toContain('Read');
    expect(overlay).toContain('file.ts');
    expect(overlay).toContain('…');
  });

  it('getOverlay shows completed tools with outcome', () => {
    const lane = new ToolLane();
    lane.addStart('tu_1', 'Read', ' file.ts');
    lane.addResult('tu_1', makeResult({ toolUseId: 'tu_1', lineCount: 77 }));
    const overlay = strip(lane.getOverlay());
    expect(overlay).toContain('Read');
    expect(overlay).toContain('77 lines');
    expect(overlay).not.toContain('…');
  });

  it('flush returns single-line result for one tool', () => {
    const lane = new ToolLane();
    lane.addStart('tu_1', 'Read', ' package.json');
    lane.addResult('tu_1', makeResult({ toolUseId: 'tu_1', lineCount: 77 }));
    const lines = lane.flush();
    expect(lines).toHaveLength(1);
    const text = strip(lines[0]!);
    expect(text).toContain('Read');
    expect(text).toContain('package.json');
    expect(text).toContain('77 lines');
  });

  it('flush groups multiple same-tool calls', () => {
    const lane = new ToolLane();
    lane.addStart('tu_1', 'Glob', ' src/');
    lane.addStart('tu_2', 'Glob', ' tests/');
    lane.addStart('tu_3', 'Glob', ' docs/');
    lane.addResult('tu_1', makeResult({ toolUseId: 'tu_1', lineCount: 101 }));
    lane.addResult('tu_2', makeResult({ toolUseId: 'tu_2', lineCount: 101 }));
    lane.addResult('tu_3', makeResult({ toolUseId: 'tu_3', lineCount: 101 }));
    const lines = lane.flush();
    expect(lines).toHaveLength(1);
    const text = strip(lines[0]!);
    expect(text).toContain('Glob');
    expect(text).toContain('×3');
    expect(text).toContain('101 lines each');
  });

  it('flush shows total lines when counts differ', () => {
    const lane = new ToolLane();
    lane.addStart('tu_1', 'Read', ' a.ts');
    lane.addStart('tu_2', 'Read', ' b.ts');
    lane.addResult('tu_1', makeResult({ toolUseId: 'tu_1', lineCount: 30 }));
    lane.addResult('tu_2', makeResult({ toolUseId: 'tu_2', lineCount: 70 }));
    const lines = lane.flush();
    expect(lines).toHaveLength(1);
    const text = strip(lines[0]!);
    expect(text).toContain('×2');
    expect(text).toContain('100 lines total');
  });

  it('flush surfaces error count in grouped results', () => {
    const lane = new ToolLane();
    lane.addStart('tu_1', 'Read', ' good.ts');
    lane.addStart('tu_2', 'Read', ' bad.ts');
    lane.addResult('tu_1', makeResult({ toolUseId: 'tu_1', lineCount: 50 }));
    lane.addResult('tu_2', makeResult({ toolUseId: 'tu_2', content: 'EISDIR', isError: true }));
    const lines = lane.flush();
    expect(lines).toHaveLength(1);
    const text = strip(lines[0]!);
    expect(text).toContain('1 error');
  });

  it('flush produces separate lines for different tool types', () => {
    const lane = new ToolLane();
    lane.addStart('tu_1', 'Bash', ' ls -la');
    lane.addStart('tu_2', 'Read', ' file.ts');
    lane.addStart('tu_3', 'Read', ' other.ts');
    lane.addResult('tu_1', makeResult({ toolUseId: 'tu_1', lineCount: 10 }));
    lane.addResult('tu_2', makeResult({ toolUseId: 'tu_2', lineCount: 50 }));
    lane.addResult('tu_3', makeResult({ toolUseId: 'tu_3', lineCount: 60 }));
    const lines = lane.flush();
    expect(lines).toHaveLength(2);
    expect(strip(lines[0]!)).toContain('Bash');
    expect(strip(lines[1]!)).toContain('Read');
    expect(strip(lines[1]!)).toContain('×2');
  });

  it('flush clears state', () => {
    const lane = new ToolLane();
    lane.addStart('tu_1', 'Read', ' file.ts');
    lane.addResult('tu_1', makeResult({ toolUseId: 'tu_1' }));
    lane.flush();
    expect(lane.hasPending()).toBe(false);
    expect(lane.flush()).toHaveLength(0);
  });

  describe('nested subagents', () => {
    it('overlay renders depth-2: Agent → Agent → Read', () => {
      const lane = new ToolLane();
      lane.addStart('a1', 'Agent', '("research")');
      lane.addStart('a2', 'Agent', '("web-search")');
      lane.addStart('tu_r', 'Read', ' file.ts');
      lane.addResult('tu_r', makeResult({ toolUseId: 'tu_r', lineCount: 20 }));
      lane.addResult('a2', makeResult({ toolUseId: 'a2', content: 'done' }));
      lane.addResult('a1', makeResult({ toolUseId: 'a1', content: 'done' }));

      const overlay = strip(lane.getOverlay());
      const lines = overlay.split('\n');
      expect(lines[0]).toContain('Agent');
      expect(lines[0]).toContain('research');
      expect(lines[1]).toContain('Agent');
      expect(lines[1]).toContain('web-search');
      expect(lines[2]).toContain('Read');
      expect(lines[2]).toContain('20 lines');
    });

    it('overlay renders depth-3: Agent → Agent → Agent → Bash', () => {
      const lane = new ToolLane();
      lane.addStart('a1', 'Agent', '("top")');
      lane.addStart('a2', 'Agent', '("mid")');
      lane.addStart('a3', 'Agent', '("inner")');
      lane.addStart('tu_b', 'Bash', ' ls');
      lane.addResult('tu_b', makeResult({ toolUseId: 'tu_b', lineCount: 5 }));
      lane.addResult('a3', makeResult({ toolUseId: 'a3', content: 'done' }));
      lane.addResult('a2', makeResult({ toolUseId: 'a2', content: 'done' }));
      lane.addResult('a1', makeResult({ toolUseId: 'a1', content: 'done' }));

      const overlay = strip(lane.getOverlay());
      const lines = overlay.split('\n');
      expect(lines).toHaveLength(4);
      expect(lines[0]).toContain('top');
      expect(lines[1]).toContain('mid');
      expect(lines[2]).toContain('inner');
      expect(lines[3]).toContain('Bash');
    });

    it('overlay increases indentation with depth', () => {
      const lane = new ToolLane();
      lane.addStart('a1', 'Agent', '("top")');
      lane.addStart('a2', 'Agent', '("mid")');
      lane.addStart('tu_r', 'Read', ' file.ts');

      const overlay = strip(lane.getOverlay());
      const lines = overlay.split('\n');
      // Indent prefix = leading whitespace + spine glyphs (`│`) + tree
      // connectors (`├ ╰ ─`). Each nesting depth adds 2 cells of indent;
      // measure by content-start column, not by whitespace alone.
      // ANSI escapes are stripped above so the regex sees plain chars.
      const indentPattern = /^[\s│├╰─└┌]*/;
      const indents = lines.map((l) => l.match(indentPattern)?.[0]?.length ?? 0);
      expect(indents[1]).toBeGreaterThan(indents[0]!);
      expect(indents[2]).toBeGreaterThan(indents[1]!);
    });

    it('flush renders nested agent tree', () => {
      const lane = new ToolLane();
      lane.addStart('a1', 'Agent', '("research")');
      lane.addStart('a2', 'Agent', '("verify")');
      lane.addStart('tu_r', 'Read', ' src/index.ts');
      lane.addResult('tu_r', makeResult({ toolUseId: 'tu_r', lineCount: 42 }));
      lane.addResult('a2', makeResult({ toolUseId: 'a2', content: 'verified' }));
      lane.addResult('a1', makeResult({ toolUseId: 'a1', content: 'done' }));

      const lines = lane.flush();
      expect(lines).toHaveLength(1);
      const text = strip(lines[0]!);
      expect(text).toContain('research');
      expect(text).toContain('verify');
      expect(text).toContain('Read');
      expect(text).toContain('42 lines');
    });

    it('overflow at nested depth collapses same-tool siblings into a grouped row', () => {
      const lane = new ToolLane();
      lane.addStart('a1', 'Agent', '("parent")');
      lane.addStart('a2', 'Agent', '("child")');
      lane.addStart('t1', 'Read', ' a.ts');
      lane.addStart('t2', 'Read', ' b.ts');
      lane.addStart('t3', 'Read', ' c.ts');
      lane.addStart('t4', 'Read', ' d.ts');
      lane.addResult('t1', makeResult({ toolUseId: 't1', lineCount: 10 }));
      lane.addResult('t2', makeResult({ toolUseId: 't2', lineCount: 10 }));
      lane.addResult('t3', makeResult({ toolUseId: 't3', lineCount: 10 }));
      lane.addResult('t4', makeResult({ toolUseId: 't4', lineCount: 10 }));
      lane.addResult('a2', makeResult({ toolUseId: 'a2', content: 'done' }));
      lane.addResult('a1', makeResult({ toolUseId: 'a1', content: 'done' }));

      const overlay = strip(lane.getOverlay());
      // 4 Read siblings ≥ threshold-3 → collapse to a single grouped row
      expect(overlay).toContain('Read');
      expect(overlay).toContain('×4');
      expect(overlay).toContain('4 done');
      expect(overlay).not.toContain('tool uses');
    });

    it('mixed root tools and nested agents render correctly', () => {
      const lane = new ToolLane();
      lane.addStart('tu_root', 'Read', ' root.ts');
      lane.addResult('tu_root', makeResult({ toolUseId: 'tu_root', lineCount: 10 }));
      lane.addStart('a1', 'Agent', '("nested")');
      lane.addStart('a2', 'Agent', '("deep")');
      lane.addStart('tu_inner', 'Bash', ' echo hi');
      lane.addResult('tu_inner', makeResult({ toolUseId: 'tu_inner', lineCount: 1 }));
      lane.addResult('a2', makeResult({ toolUseId: 'a2', content: 'done' }));
      lane.addResult('a1', makeResult({ toolUseId: 'a1', content: 'done' }));

      const overlay = strip(lane.getOverlay());
      const lines = overlay.split('\n');
      expect(lines[0]).toContain('Read');
      expect(lines[0]).toContain('root.ts');
      expect(lines[1]).toContain('nested');
      expect(lines[2]).toContain('deep');
      expect(lines[3]).toContain('Bash');
    });

    it('stack restores parent context after nested agent completes', () => {
      const lane = new ToolLane();
      lane.addStart('a1', 'Agent', '("parent")');
      lane.addStart('a2', 'Agent', '("child")');
      lane.addStart('t1', 'Read', ' inner.ts');
      lane.addResult('t1', makeResult({ toolUseId: 't1', lineCount: 5 }));
      lane.addResult('a2', makeResult({ toolUseId: 'a2', content: 'done' }));
      // After a2 completes, subsequent tools should be children of a1
      lane.addStart('t2', 'Bash', ' ls');
      lane.addResult('t2', makeResult({ toolUseId: 't2', lineCount: 3 }));
      lane.addResult('a1', makeResult({ toolUseId: 'a1', content: 'done' }));

      const overlay = strip(lane.getOverlay());
      const lines = overlay.split('\n');
      // Structure: Agent("parent") > [Agent("child") > [Read], Bash]
      expect(lines[0]).toContain('parent');
      expect(lines[1]).toContain('child');
      expect(lines[2]).toContain('Read');
      // Bash should be a sibling of child agent (under parent), not a grandchild
      const bashLine = lines.find((l) => l.includes('Bash'));
      const childLine = lines.find((l) => l.includes('child'));
      expect(bashLine).toBeDefined();
      expect(childLine).toBeDefined();
      const bashIndent = bashLine!.match(/^(\s*)/)?.[1]?.length ?? 0;
      const childIndent = childLine!.match(/^(\s*)/)?.[1]?.length ?? 0;
      expect(bashIndent).toBe(childIndent);
    });
  });
});

/**
 * Overlay layering — `runTurn`'s `renderProgress` closure builds a single
 * overlay frame that prepends `ToolLane.getOverlay()` when `hasPending()` is
 * true, then appends the joined progress banner lines. This contract test
 * mirrors that composition using the public APIs and verifies that both
 * surfaces survive concatenation by `'\n'`.
 *
 * If this test breaks, the new overlay-layering behavior in
 * `turn-handler.ts:154-157` has regressed — pending tools and progress
 * banners can no longer coexist in one frame.
 */
describe('overlay layering — ToolLane × progress banner', () => {
  let originalLevel: typeof chalk.level;
  beforeAll(() => {
    originalLevel = chalk.level;
    chalk.level = 3;
  });
  afterAll(() => {
    chalk.level = originalLevel;
  });

  const buildLayeredOverlay = (lane: ToolLane, bannerLines: string[]): string => {
    const overlayParts: string[] = [];
    if (lane.hasPending()) overlayParts.push(lane.getOverlay());
    overlayParts.push(bannerLines.join('\n'));
    return overlayParts.join('\n');
  };

  it('combines tool overlay and progress banner when both are present', () => {
    const lane = new ToolLane();
    lane.addStart('tu_1', 'Read', ' file.ts');
    const bannerLines = formatProgressBanner({
      taskId: 't1',
      description: 'Researching codebase',
      lastToolName: 'Grep',
      toolUses: 2,
      totalTokens: 800,
      durationMs: 3000,
    });
    const overlay = strip(buildLayeredOverlay(lane, bannerLines));
    // Tool overlay carries the pending tool name + path
    expect(overlay).toContain('Read');
    expect(overlay).toContain('file.ts');
    // Banner carries the progress glyph + description
    expect(overlay).toContain('◦ Researching codebase');
    // Tool overlay sits above the banner
    expect(overlay.indexOf('Read')).toBeLessThan(overlay.indexOf('Researching codebase'));
  });

  it('omits tool overlay when no tools are pending', () => {
    const lane = new ToolLane();
    const bannerLines = formatProgressBanner({
      taskId: 't1',
      description: 'Just thinking',
      toolUses: 0,
      totalTokens: 0,
      durationMs: 0,
    });
    const overlay = strip(buildLayeredOverlay(lane, bannerLines));
    expect(overlay).toContain('◦ Just thinking');
    expect(overlay).not.toContain('Read');
    // Should not start with a stray newline from an empty tool overlay
    expect(overlay.startsWith('\n')).toBe(false);
  });
});
