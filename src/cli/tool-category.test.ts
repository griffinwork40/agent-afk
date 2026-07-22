/**
 * Tests for src/cli/tool-category.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import chalk, { type ChalkInstance } from 'chalk';
import {
  categorizeTool,
  dispatchTagForCategory,
  styleForCategory,
  styleForToolName,
  SUBAGENT_TOOLS,
  DAG_TOOLS,
  SKILL_TOOLS,
  NESTING_TOOLS,
  type ToolCategory,
} from './tool-category.js';
import { palette } from './palette.js';

/**
 * A stand-in `ChalkInstance` that renders `<tag>:<text>` uncolored. Used to
 * prove a "read `palette.<role>` at call time" invariant deterministically,
 * sidestepping chalk's own ANSI-downsample quantization (which bakes in at
 * `hex()` property-access time and can make two distinct tones coincidentally
 * render identical bytes at a low color level).
 */
function sentinelChalk(tag: string): ChalkInstance {
  return ((...text: unknown[]) => `${tag}:${text.join(' ')}`) as ChalkInstance;
}

const ALL_CATEGORIES: ToolCategory[] = [
  'read',
  'write',
  'shell',
  'subagent',
  'skill',
  'dag',
  'mcp',
  'web',
  'browser',
  'planning',
  'schedule',
  'other',
];

describe('categorizeTool', () => {
  it.each([
    ['Read', 'read'],
    ['Glob', 'read'],
    ['Grep', 'read'],
    ['NotebookRead', 'read'],
    ['LS', 'read'],
    ['Write', 'write'],
    ['Edit', 'write'],
    ['NotebookEdit', 'write'],
    ['MultiEdit', 'write'],
    ['Bash', 'shell'],
    ['BashOutput', 'shell'],
    ['KillBash', 'shell'],
    ['Agent', 'subagent'],
    ['Task', 'subagent'],
    ['Skill', 'skill'],
    ['Compose', 'dag'],
    ['WebFetch', 'web'],
    ['WebSearch', 'web'],
    // agent-afk built-in snake_case tool names (src/agent/tools/schemas.ts)
    ['bash', 'shell'],
    ['read_file', 'read'],
    ['write_file', 'write'],
    ['edit_file', 'write'],
    ['glob', 'read'],
    ['grep', 'read'],
    ['list_directory', 'read'],
    ['send_telegram', 'web'],
    ['web_scrape', 'web'],
    // browser-control tools — distinct from web because they drive a
    // stateful headed session, not a one-shot HTTP request.
    ['browser_open', 'browser'],
    ['browser_observe', 'browser'],
    ['browser_act', 'browser'],
    ['browser_screenshot', 'browser'],
    ['browser_extract', 'browser'],
    ['browser_close', 'browser'],
    ['agent', 'subagent'],
    ['skill', 'skill'],
    ['compose', 'dag'],
    // memory-tools.ts — read-only query vs mutating writes.
    // memory_search is in the dispatcher's SAFE_TOOLS concurrency set; the
    // other two persist to disk (HOT.md / SQLite fact archive / procedures
    // directory) and share the write bucket with file edits.
    ['memory_search', 'read'],
    ['memory_update', 'write'],
    ['procedure_write', 'write'],
    ['TaskCreate', 'planning'],
    ['TaskUpdate', 'planning'],
    ['TaskList', 'planning'],
    ['TaskGet', 'planning'],
    ['TaskOutput', 'planning'],
    ['TaskStop', 'planning'],
    ['EnterPlanMode', 'planning'],
    ['ExitPlanMode', 'planning'],
    ['ToolSearch', 'planning'],
    // schedule tools — daemon lifecycle management.
    ['create_schedule', 'schedule'],
    ['list_schedules', 'schedule'],
    ['get_schedule_history', 'schedule'],
    ['cancel_schedule', 'schedule'],
    // editor settings tool — mutates settings.json on disk.
    ['terminal_font_size', 'write'],
  ] as Array<[string, ToolCategory]>)('categorizes %s as %s', (name, expected) => {
    expect(categorizeTool(name)).toBe(expected);
  });

  it('categorizes any mcp__-prefixed name as mcp', () => {
    expect(categorizeTool('mcp__github__create_issue')).toBe('mcp');
    expect(categorizeTool('mcp__server__tool_name')).toBe('mcp');
    expect(categorizeTool('mcp__a__b__c')).toBe('mcp');
  });

  it('falls back to "other" for unknown names', () => {
    expect(categorizeTool('UnknownTool')).toBe('other');
    expect(categorizeTool('Foo')).toBe('other');
    expect(categorizeTool('')).toBe('other');
  });

  it('tolerates lowercase first-char from non-SDK providers', () => {
    expect(categorizeTool('read')).toBe('read');
    expect(categorizeTool('bash')).toBe('shell');
    expect(categorizeTool('skill')).toBe('skill');
    expect(categorizeTool('agent')).toBe('subagent');
  });

  it('still returns other for fully-uppercase or unknown casing', () => {
    expect(categorizeTool('BASH')).toBe('other');
    expect(categorizeTool('READ')).toBe('other');
  });
});

describe('styleForCategory', () => {
  let originalLevel: typeof chalk.level;
  beforeAll(() => {
    originalLevel = chalk.level;
    chalk.level = 3;
  });
  afterAll(() => {
    chalk.level = originalLevel;
  });

  it.each(ALL_CATEGORIES)('returns a callable color and a non-empty glyph for %s', (cat) => {
    const { color, glyph } = styleForCategory(cat);
    expect(typeof color).toBe('function');
    expect(typeof glyph).toBe('string');
    expect(glyph.length).toBeGreaterThan(0);
  });

  it('each color emits ANSI when chalk is enabled', () => {
    for (const cat of ALL_CATEGORIES) {
      const { color } = styleForCategory(cat);
      expect(color('hello')).toContain('hello');
      expect(color('hello')).toMatch(/\x1b\[/);
    }
  });

  it('the four highest-traffic categories have distinct glyphs', () => {
    const glyphs = new Set([
      styleForCategory('read').glyph,
      styleForCategory('write').glyph,
      styleForCategory('shell').glyph,
      styleForCategory('subagent').glyph,
    ]);
    expect(glyphs.size).toBe(4);
  });

  it('the three dispatch-class categories have distinct glyphs', () => {
    // subagent / skill / dag are conceptually adjacent ("this dispatches
    // more work") — they must remain visually distinguishable.
    const glyphs = new Set([
      styleForCategory('subagent').glyph,
      styleForCategory('skill').glyph,
      styleForCategory('dag').glyph,
    ]);
    expect(glyphs.size).toBe(3);
  });

  it('dag is not the same glyph as other (was the bug pre-fix)', () => {
    expect(styleForCategory('dag').glyph).not.toBe(styleForCategory('other').glyph);
  });

  it('resolves palette-sourced category colors from `palette` at call time, not at module load (no theme-swap freeze)', () => {
    // Regression: subagent/planning/other resolved `palette.plan`/`palette.meta`
    // into a module-level const lookup at import time, so a theme swap (which
    // mutates `palette`'s members in place — see applyTheme()) left them
    // frozen to whatever theme was active at module load. Swapping the
    // backing palette roles to distinct sentinel renderers directly (the
    // same mechanism applyTheme uses) proves each is re-read on every call
    // rather than captured once. The chalk.hex(...) literal entries (e.g.
    // read/write) are theme-agnostic by design and intentionally excluded.
    // See PR #643 review.
    const savedPlan = palette.plan;
    const savedMeta = palette.meta;
    try {
      palette.plan = sentinelChalk('PLAN-A');
      palette.meta = sentinelChalk('META-A');
      expect(styleForCategory('subagent').color('x')).toBe('PLAN-A:x');
      expect(styleForCategory('planning').color('x')).toBe('META-A:x');
      expect(styleForCategory('other').color('x')).toBe('META-A:x');

      palette.plan = sentinelChalk('PLAN-B');
      palette.meta = sentinelChalk('META-B');
      expect(styleForCategory('subagent').color('x')).toBe('PLAN-B:x');
      expect(styleForCategory('planning').color('x')).toBe('META-B:x');
      expect(styleForCategory('other').color('x')).toBe('META-B:x');
    } finally {
      palette.plan = savedPlan;
      palette.meta = savedMeta;
    }
  });
});

describe('dispatchTagForCategory', () => {
  it('returns the dispatch-class tag for subagent/skill/dag', () => {
    expect(dispatchTagForCategory('subagent')).toBe('subagent');
    expect(dispatchTagForCategory('skill')).toBe('skill');
    expect(dispatchTagForCategory('dag')).toBe('dag');
  });

  it('returns undefined for direct-action categories', () => {
    expect(dispatchTagForCategory('read')).toBeUndefined();
    expect(dispatchTagForCategory('write')).toBeUndefined();
    expect(dispatchTagForCategory('shell')).toBeUndefined();
    expect(dispatchTagForCategory('web')).toBeUndefined();
    expect(dispatchTagForCategory('mcp')).toBeUndefined();
    expect(dispatchTagForCategory('planning')).toBeUndefined();
    expect(dispatchTagForCategory('schedule')).toBeUndefined();
    expect(dispatchTagForCategory('other')).toBeUndefined();
  });
});

describe('NESTING_TOOLS', () => {
  it('is the union of SUBAGENT_TOOLS, DAG_TOOLS, and SKILL_TOOLS', () => {
    for (const name of SUBAGENT_TOOLS) expect(NESTING_TOOLS.has(name)).toBe(true);
    for (const name of DAG_TOOLS) expect(NESTING_TOOLS.has(name)).toBe(true);
    for (const name of SKILL_TOOLS) expect(NESTING_TOOLS.has(name)).toBe(true);
  });

  it('is EXACTLY the union of SUBAGENT_TOOLS, DAG_TOOLS, and SKILL_TOOLS — no foreign members, correct size', () => {
    // Build the expected union manually so the assertion is independent of the
    // implementation. Any tool added to NESTING_TOOLS without also being added
    // to one of the contributing sets will fail this test.
    const expected = new Set<string>([...SUBAGENT_TOOLS, ...DAG_TOOLS, ...SKILL_TOOLS]);

    for (const name of NESTING_TOOLS) {
      expect(expected.has(name), `"${name}" is in NESTING_TOOLS but not in SUBAGENT_TOOLS/DAG_TOOLS/SKILL_TOOLS`).toBe(true);
    }

    expect(NESTING_TOOLS.size).toBe(expected.size);
  });

  it('does NOT contain direct-action tools (gate must stay tight)', () => {
    for (const name of ['Read', 'Write', 'Bash', 'bash', 'read_file', 'WebFetch']) {
      expect(NESTING_TOOLS.has(name)).toBe(false);
    }
  });

  it('contains both case variants of dispatch tools so the renderer gate matches what the SDK sends', () => {
    // PascalCase (Anthropic SDK)
    expect(NESTING_TOOLS.has('Agent')).toBe(true);
    expect(NESTING_TOOLS.has('Task')).toBe(true);
    expect(NESTING_TOOLS.has('Compose')).toBe(true);
    expect(NESTING_TOOLS.has('Skill')).toBe(true);
    // snake_case (agent-afk built-in schemas)
    expect(NESTING_TOOLS.has('agent')).toBe(true);
    expect(NESTING_TOOLS.has('compose')).toBe(true);
    expect(NESTING_TOOLS.has('skill')).toBe(true);
  });
});

describe('styleForToolName', () => {
  it('routes through categorizeTool', () => {
    expect(styleForToolName('Read').glyph).toBe(styleForCategory('read').glyph);
    expect(styleForToolName('Bash').glyph).toBe(styleForCategory('shell').glyph);
    expect(styleForToolName('mcp__x__y').glyph).toBe(styleForCategory('mcp').glyph);
    expect(styleForToolName('Unknown').glyph).toBe(styleForCategory('other').glyph);
  });
});
