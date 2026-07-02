/**
 * Tests for the Claude Code subagent markdown parser.
 */

import { describe, expect, it, vi } from 'vitest';
import { parseAgentMarkdown } from './parser.js';

const VALID = `---
name: code-reviewer
description: Reviews code for quality
tools: Read, Glob, Grep
model: sonnet
---

You are a code reviewer. Analyze the code.`;

describe('parseAgentMarkdown', () => {
  it('parses required fields, tools, model, and body-as-prompt', () => {
    const parsed = parseAgentMarkdown(VALID);
    expect(parsed).toBeDefined();
    expect(parsed?.name).toBe('code-reviewer');
    expect(parsed?.definition.description).toBe('Reviews code for quality');
    expect(parsed?.definition.tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(parsed?.definition.model).toBe('sonnet');
    expect(parsed?.definition.prompt).toBe('You are a code reviewer. Analyze the code.');
  });

  it('returns undefined without frontmatter', () => {
    const warn = vi.fn();
    expect(parseAgentMarkdown('just a plain file', warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('frontmatter'));
  });

  it('returns undefined when name or description is missing', () => {
    expect(
      parseAgentMarkdown('---\ndescription: no name\n---\nbody'),
    ).toBeUndefined();
    expect(parseAgentMarkdown('---\nname: no-desc\n---\nbody')).toBeUndefined();
  });

  it('returns undefined when the body (system prompt) is empty', () => {
    const warn = vi.fn();
    expect(
      parseAgentMarkdown('---\nname: x\ndescription: y\n---\n   \n', warn),
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('empty body'));
  });

  it('parses YAML-list tools and disallowedTools (both spellings)', () => {
    const doc = `---
name: lists
description: list forms
tools:
  - Read
  - Grep
disallowed-tools: Write, Edit
---
prompt body`;
    const parsed = parseAgentMarkdown(doc);
    expect(parsed?.definition.tools).toEqual(['Read', 'Grep']);
    expect(parsed?.definition.disallowedTools).toEqual(['Write', 'Edit']);
  });

  it('accepts allowed-tools as a space-separated alias (agentskills.io form)', () => {
    const doc = `---
name: spacey
description: space separated
allowed-tools: Read Grep Glob
---
prompt`;
    const parsed = parseAgentMarkdown(doc);
    expect(parsed?.definition.tools).toEqual(['Read', 'Grep', 'Glob']);
  });

  it('keeps Agent(...) paren groups intact through tokenization', () => {
    const doc = `---
name: coordinator
description: with paren group
tools: Agent(worker, researcher), Read
---
prompt`;
    const parsed = parseAgentMarkdown(doc);
    // Comma-splitting fragments the group; the resolver handles fragments.
    expect(parsed?.definition.tools).toContain('Agent(worker');
    expect(parsed?.definition.tools).toContain('Read');
  });

  it('parses maxTurns and the bash: read-only AFK extension', () => {
    const doc = `---
name: budgeted
description: with budget
maxTurns: 5
bash: read-only
---
prompt`;
    const parsed = parseAgentMarkdown(doc);
    expect(parsed?.definition.maxTurns).toBe(5);
    expect(parsed?.bashReadOnly).toBe(true);
  });

  it('records recognized long-tail fields as ignoredKeys and warns on unknown keys', () => {
    const warn = vi.fn();
    const doc = `---
name: longtail
description: fields galore
memory: project
color: red
isolation: worktree
totally-made-up: nope
---
prompt`;
    const parsed = parseAgentMarkdown(doc, warn);
    expect(parsed?.ignoredKeys).toEqual(['memory', 'color', 'isolation']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('totally-made-up'));
  });

  it('joins folded multi-line descriptions', () => {
    const doc = `---
name: folded
description: >-
  A long description
  spanning lines
---
prompt`;
    const parsed = parseAgentMarkdown(doc);
    expect(parsed?.definition.description).toBe('A long description spanning lines');
  });

  it('strips quotes from scalar values', () => {
    const doc = `---
name: "quoted"
description: 'single quoted desc'
model: "opus"
---
prompt`;
    const parsed = parseAgentMarkdown(doc);
    expect(parsed?.name).toBe('quoted');
    expect(parsed?.definition.description).toBe('single quoted desc');
    expect(parsed?.definition.model).toBe('opus');
  });
});
