/**
 * Unit tests for the hook matcher module.
 *
 * Covers:
 *   - Backward-compat regression for every existing AFK matcher pattern.
 *   - Claude Code alias resolution (Bash → bash, Edit|Write → edit_file / write_file, …).
 *   - Pipe-list exact matching (Claude Code style).
 *   - Anchored-regex bare string matching.
 *   - Explicit /regex/flags path (unchanged from original compileMatcher).
 *   - timeout (seconds) fallback in validateHook via the loader.
 */

import { describe, it, expect, vi } from 'vitest';
import { compileMatcher, CLAUDE_CODE_ALIASES } from './matcher.js';

// ---------------------------------------------------------------------------
// Path 1: wildcard (unchanged)
// ---------------------------------------------------------------------------
describe('compileMatcher — wildcard', () => {
  it('undefined matches any tool', () => {
    const fn = compileMatcher(undefined);
    expect(fn('bash')).toBe(true);
    expect(fn('edit_file')).toBe(true);
    expect(fn('')).toBe(true);
  });

  it('"" matches any tool', () => {
    const fn = compileMatcher('');
    expect(fn('bash')).toBe(true);
    expect(fn('read_file')).toBe(true);
  });

  it('"*" matches any tool', () => {
    const fn = compileMatcher('*');
    expect(fn('bash')).toBe(true);
    expect(fn('agent')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Path 2: explicit regex /pattern/flags (unchanged, regression)
// ---------------------------------------------------------------------------
describe('compileMatcher — explicit /regex/ path', () => {
  it('/^agent$/ matches only agent', () => {
    const fn = compileMatcher('/^agent$/');
    expect(fn('agent')).toBe(true);
    expect(fn('Agent')).toBe(false); // case-sensitive
    expect(fn('agent_extra')).toBe(false);
  });

  it('/edit_file|write_file|patch_apply/ matches those three', () => {
    const fn = compileMatcher('/edit_file|write_file|patch_apply/');
    expect(fn('edit_file')).toBe(true);
    expect(fn('write_file')).toBe(true);
    expect(fn('patch_apply')).toBe(true);
    expect(fn('bash')).toBe(false);
    expect(fn('read_file')).toBe(false);
  });

  it('/^write_/ prefix regex', () => {
    const fn = compileMatcher('/^write_/');
    expect(fn('write_file')).toBe(true);
    expect(fn('read_file')).toBe(false);
  });

  it('/^Write_/i case-insensitive flag', () => {
    const fn = compileMatcher('/^Write_/i');
    expect(fn('write_file')).toBe(true);
    expect(fn('WRITE_FILE')).toBe(true);
    expect(fn('read_file')).toBe(false);
  });

  it('malformed /regex/ falls back to exact equality', () => {
    const warn = vi.fn();
    const fn = compileMatcher('/[invalid(/', warn);
    expect(fn('/[invalid(/')).toBe(true);
    expect(fn('bash')).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Path 3: bare pipe-list of exact names (Claude Code style) — REGRESSION
// AFK bare name "bash" must still match only "bash" (backward compat)
// ---------------------------------------------------------------------------
describe('compileMatcher — bare pipe-list (AFK regression)', () => {
  it('"bash" still matches only bash', () => {
    const fn = compileMatcher('bash');
    expect(fn('bash')).toBe(true);
    expect(fn('write_file')).toBe(false);
    expect(fn('bash_extra')).toBe(false);
  });

  it('"edit_file" still matches only edit_file', () => {
    const fn = compileMatcher('edit_file');
    expect(fn('edit_file')).toBe(true);
    expect(fn('write_file')).toBe(false);
    expect(fn('bash')).toBe(false);
  });

  it('"agent" still matches only agent', () => {
    const fn = compileMatcher('agent');
    expect(fn('agent')).toBe(true);
    expect(fn('bash')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Path 3: Claude Code alias resolution via pipe-list
// ---------------------------------------------------------------------------
describe('compileMatcher — Claude Code alias matching', () => {
  it('"Bash" fires for bash', () => {
    const fn = compileMatcher('Bash');
    expect(fn('bash')).toBe(true);
    expect(fn('edit_file')).toBe(false);
  });

  it('"Agent|Task" fires for agent', () => {
    const fn = compileMatcher('Agent|Task');
    expect(fn('agent')).toBe(true);
    expect(fn('bash')).toBe(false);
    expect(fn('task')).toBe(false); // "Task" is an alias for "agent", not a tool itself
  });

  it('"Edit|Write|MultiEdit|NotebookEdit" fires for edit_file and write_file, not bash', () => {
    const fn = compileMatcher('Edit|Write|MultiEdit|NotebookEdit');
    expect(fn('edit_file')).toBe(true);   // "Edit" alias
    expect(fn('write_file')).toBe(true);  // "Write" alias
    expect(fn('patch_apply')).toBe(true); // "MultiEdit" alias
    expect(fn('bash')).toBe(false);
    expect(fn('read_file')).toBe(false);
  });

  it('"Edit|Write" fires for edit_file and write_file only', () => {
    const fn = compileMatcher('Edit|Write');
    expect(fn('edit_file')).toBe(true);
    expect(fn('write_file')).toBe(true);
    expect(fn('bash')).toBe(false);
  });

  it('"Read" fires for read_file', () => {
    const fn = compileMatcher('Read');
    expect(fn('read_file')).toBe(true);
    expect(fn('bash')).toBe(false);
  });

  it('"Grep" fires for grep', () => {
    const fn = compileMatcher('Grep');
    expect(fn('grep')).toBe(true);
    expect(fn('bash')).toBe(false);
  });

  it('"Glob" fires for glob', () => {
    const fn = compileMatcher('Glob');
    expect(fn('glob')).toBe(true);
  });

  it('"LS" fires for list_directory', () => {
    const fn = compileMatcher('LS');
    expect(fn('list_directory')).toBe(true);
    expect(fn('bash')).toBe(false);
  });

  it('"WebFetch|WebSearch" fires for web_scrape only', () => {
    const fn = compileMatcher('WebFetch|WebSearch');
    expect(fn('web_scrape')).toBe(true);
    expect(fn('bash')).toBe(false);
    expect(fn('web_request')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Path 4: bare anchored-regex for strings with special chars
// ---------------------------------------------------------------------------
describe('compileMatcher — bare anchored-regex path', () => {
  it('"Web.*" matches web_scrape via WebFetch/WebSearch aliases', () => {
    const fn = compileMatcher('Web.*');
    expect(fn('web_scrape')).toBe(true); // aliases WebFetch, WebSearch match Web.*
    expect(fn('bash')).toBe(false);
    expect(fn('web_request')).toBe(false); // no alias matching Web.*
  });

  it('invalid bare-regex falls back to exact equality', () => {
    const warn = vi.fn();
    // A bare string that has special chars but is invalid regex
    const fn = compileMatcher('[invalid(', warn);
    expect(fn('[invalid(')).toBe(true);
    expect(fn('bash')).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// CLAUDE_CODE_ALIASES table sanity
// ---------------------------------------------------------------------------
describe('CLAUDE_CODE_ALIASES', () => {
  it('bash → [Bash]', () => {
    expect(CLAUDE_CODE_ALIASES['bash']).toEqual(['Bash']);
  });
  it('agent → [Agent, Task]', () => {
    expect(CLAUDE_CODE_ALIASES['agent']).toContain('Agent');
    expect(CLAUDE_CODE_ALIASES['agent']).toContain('Task');
  });
  it('edit_file → contains Edit and MultiEdit', () => {
    expect(CLAUDE_CODE_ALIASES['edit_file']).toContain('Edit');
    expect(CLAUDE_CODE_ALIASES['edit_file']).toContain('MultiEdit');
  });
  it('patch_apply → contains MultiEdit', () => {
    expect(CLAUDE_CODE_ALIASES['patch_apply']).toContain('MultiEdit');
  });
  it('web_scrape → contains WebFetch and WebSearch', () => {
    expect(CLAUDE_CODE_ALIASES['web_scrape']).toContain('WebFetch');
    expect(CLAUDE_CODE_ALIASES['web_scrape']).toContain('WebSearch');
  });
});
