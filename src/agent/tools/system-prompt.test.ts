/**
 * Tests for the shared tool/memory system-prompt resolvers.
 *
 * These pin the single-source-of-truth contract that BOTH providers
 * (anthropic-direct and openai-compatible) rely on. The background-subagent
 * regression block guards the specific defect where the compound prompt gained
 * the `<background-subagent-result>` fragment but a provider's inline
 * hand-rolled concatenation fell behind and never delivered it to the model.
 */

import { describe, it, expect } from 'vitest';
import {
  TOOL_SYSTEM_PROMPT_BASE,
  TOOL_SYSTEM_PROMPT,
  SLASH_COMMAND_ROUTING_PROMPT,
  BASH_PASSTHROUGH_PROMPT,
  BG_SUBAGENT_RESULT_PROMPT,
  MEMORY_SYSTEM_PROMPT,
  MEMORY_SYSTEM_PROMPT_READONLY,
  resolveToolSystemPrompt,
  resolveMemorySystemPrompt,
} from './system-prompt.js';

describe('resolveToolSystemPrompt', () => {
  it('returns the full compound for a non-skill-dispatch session (false)', () => {
    expect(resolveToolSystemPrompt(false)).toBe(TOOL_SYSTEM_PROMPT);
  });

  it('defaults to the full compound when isSkillDispatch is undefined', () => {
    // Main / interactive sessions pass undefined; they must get the full set.
    expect(resolveToolSystemPrompt(undefined)).toBe(TOOL_SYSTEM_PROMPT);
  });

  it('returns base-only for a skill-dispatch sub-agent (true)', () => {
    expect(resolveToolSystemPrompt(true)).toBe(TOOL_SYSTEM_PROMPT_BASE);
  });

  it('the compound includes ALL four interactive fragments', () => {
    // Guards against future drift: any fragment silently dropped from the
    // compound fails here.
    expect(TOOL_SYSTEM_PROMPT).toContain(TOOL_SYSTEM_PROMPT_BASE);
    expect(TOOL_SYSTEM_PROMPT).toContain(SLASH_COMMAND_ROUTING_PROMPT);
    expect(TOOL_SYSTEM_PROMPT).toContain(BASH_PASSTHROUGH_PROMPT);
    expect(TOOL_SYSTEM_PROMPT).toContain(BG_SUBAGENT_RESULT_PROMPT);
  });

  it('the base (skill-dispatch) prompt omits the interactive-only fragments', () => {
    const base = resolveToolSystemPrompt(true);
    expect(base).not.toContain('<command-name>');
    expect(base).not.toContain('<bash-passthrough>');
    expect(base).not.toContain('<background-subagent-result>');
  });
});

describe('resolveToolSystemPrompt — background-subagent delivery (H1 regression)', () => {
  it('a non-skill session is told what a <background-subagent-result> envelope is', () => {
    // This is the exact guarantee H1 broke: the interactive prompt actually
    // delivered to the model MUST describe the background-subagent envelope.
    expect(resolveToolSystemPrompt(false)).toContain('<background-subagent-result>');
    expect(resolveToolSystemPrompt(undefined)).toContain('<background-subagent-result>');
  });

  it('a skill-dispatch sub-agent is NOT told about the envelope (never receives one)', () => {
    expect(resolveToolSystemPrompt(true)).not.toContain('<background-subagent-result>');
  });
});

describe('resolveMemorySystemPrompt', () => {
  it('returns the full memory prompt for a writable session (false / undefined)', () => {
    expect(resolveMemorySystemPrompt(false)).toBe(MEMORY_SYSTEM_PROMPT);
    expect(resolveMemorySystemPrompt(undefined)).toBe(MEMORY_SYSTEM_PROMPT);
  });

  it('returns the read-only variant for a read-only child session (true)', () => {
    expect(resolveMemorySystemPrompt(true)).toBe(MEMORY_SYSTEM_PROMPT_READONLY);
  });

  it('the read-only variant omits the write-guidance section but keeps read guidance', () => {
    // The full prompt has a dedicated write section; the read-only variant must
    // not (it only mentions the write tools to say they are unavailable).
    expect(MEMORY_SYSTEM_PROMPT).toContain('## Writing memory');
    expect(MEMORY_SYSTEM_PROMPT_READONLY).not.toContain('## Writing memory');
    expect(MEMORY_SYSTEM_PROMPT_READONLY).not.toContain('## Procedures');
    expect(MEMORY_SYSTEM_PROMPT_READONLY).toContain('read-only');
  });
});
