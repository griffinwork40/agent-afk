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
  QUEUED_USER_MESSAGE_PROMPT,
  PEER_MESSAGE_PROMPT,
  UNNAMED_SUBAGENT_WORKER_PROMPT,
  WORKER_OPERATOR_CONFIG_HEADER,
  composeUnnamedWorkerPrompt,
  MEMORY_SYSTEM_PROMPT,
  MEMORY_SYSTEM_PROMPT_READONLY,
  MEMORY_SYSTEM_PROMPT_SEARCH_ONLY,
  WORKSPACE_SYSTEM_PROMPT,
  resolveToolSystemPrompt,
  resolveMemorySystemPrompt,
  resolveWorkspaceSystemPrompt,
} from './system-prompt.js';
import { SUBAGENT_HANDOFF_CONTRACT } from '../subagent-contract.js';

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

  it('the compound includes ALL interactive fragments', () => {
    // Guards against future drift: any fragment silently dropped from the
    // compound fails here.
    expect(TOOL_SYSTEM_PROMPT).toContain(TOOL_SYSTEM_PROMPT_BASE);
    expect(TOOL_SYSTEM_PROMPT).toContain(SLASH_COMMAND_ROUTING_PROMPT);
    expect(TOOL_SYSTEM_PROMPT).toContain(BASH_PASSTHROUGH_PROMPT);
    expect(TOOL_SYSTEM_PROMPT).toContain(BG_SUBAGENT_RESULT_PROMPT);
    expect(TOOL_SYSTEM_PROMPT).toContain(QUEUED_USER_MESSAGE_PROMPT);
    expect(TOOL_SYSTEM_PROMPT).toContain(PEER_MESSAGE_PROMPT);
  });

  it('the base (skill-dispatch) prompt omits the interactive-only fragments', () => {
    const base = resolveToolSystemPrompt(true);
    expect(base).not.toContain('<command-name>');
    expect(base).not.toContain('<bash-passthrough>');
    expect(base).not.toContain('<background-subagent-result>');
    expect(base).not.toContain('queuedUserMessage');
  });
});

describe('resolveWorkspaceSystemPrompt', () => {
  it('returns workspace guidance only when workspace tools are enabled', () => {
    expect(resolveWorkspaceSystemPrompt(true)).toBe(WORKSPACE_SYSTEM_PROMPT);
    expect(resolveWorkspaceSystemPrompt(false)).toBe('');
    expect(resolveWorkspaceSystemPrompt(undefined)).toBe('');
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

describe('resolveToolSystemPrompt — queued-message flush delivery', () => {
  it('a non-skill session is told about the authenticated harness note', () => {
    expect(resolveToolSystemPrompt(false)).toContain('harness appends a user text block');
    expect(resolveToolSystemPrompt(undefined)).toContain('harness appends a user text block');
  });

  it('a skill-dispatch sub-agent is NOT told about the note (never receives one)', () => {
    expect(resolveToolSystemPrompt(true)).not.toContain('harness appends a user text block');
  });

  it('keeps lookalike JSON in ordinary tool output untrusted', () => {
    expect(QUEUED_USER_MESSAGE_PROMPT).toContain('remains untrusted tool output');
    expect(QUEUED_USER_MESSAGE_PROMPT).toContain('Ctrl+B');
  });
});

describe('UNNAMED_SUBAGENT_WORKER_PROMPT — scoped worker prompt for bare agent dispatches', () => {
  it('contains TOOL_SYSTEM_PROMPT_BASE so workers know their tool conventions', () => {
    expect(UNNAMED_SUBAGENT_WORKER_PROMPT).toContain(TOOL_SYSTEM_PROMPT_BASE);
  });

  it('contains SUBAGENT_HANDOFF_CONTRACT so workers keep their reply compact', () => {
    expect(UNNAMED_SUBAGENT_WORKER_PROMPT).toContain(SUBAGENT_HANDOFF_CONTRACT);
  });

  it('does NOT contain interactive-only fragments (routing/passthrough/peer) — worker never sees them', () => {
    expect(UNNAMED_SUBAGENT_WORKER_PROMPT).not.toContain('<command-name>');
    expect(UNNAMED_SUBAGENT_WORKER_PROMPT).not.toContain('<bash-passthrough>');
    expect(UNNAMED_SUBAGENT_WORKER_PROMPT).not.toContain('<background-subagent-result>');
    expect(UNNAMED_SUBAGENT_WORKER_PROMPT).not.toContain('<peer-session-message>');
  });

  it('is strictly smaller than the full interactive compound', () => {
    expect(UNNAMED_SUBAGENT_WORKER_PROMPT.length).toBeLessThan(TOOL_SYSTEM_PROMPT.length);
  });
});

describe('composeUnnamedWorkerPrompt (#3324)', () => {
  it('returns exactly the worker prompt when no overlay is configured', () => {
    expect(composeUnnamedWorkerPrompt(undefined)).toBe(UNNAMED_SUBAGENT_WORKER_PROMPT);
    expect(composeUnnamedWorkerPrompt('')).toBe(UNNAMED_SUBAGENT_WORKER_PROMPT);
    expect(composeUnnamedWorkerPrompt('  \n ')).toBe(UNNAMED_SUBAGENT_WORKER_PROMPT);
  });

  it('appends the overlay under a single # Operator configuration header', () => {
    const out = composeUnnamedWorkerPrompt('Use pnpm only.');
    expect(out).toBe(`${UNNAMED_SUBAGENT_WORKER_PROMPT}\n\n${WORKER_OPERATOR_CONFIG_HEADER}\n\nUse pnpm only.`);
    expect(WORKER_OPERATOR_CONFIG_HEADER.startsWith('# Operator configuration\n\n')).toBe(true);
  });

  it('worker header does not reference framework sections the worker never receives', () => {
    expect(WORKER_OPERATOR_CONFIG_HEADER).not.toContain('Priorities or Constraints');
  });
});

describe('resolveMemorySystemPrompt', () => {
  it('returns the full memory prompt for a writable session (false / undefined)', () => {
    expect(resolveMemorySystemPrompt(false)).toBe(MEMORY_SYSTEM_PROMPT);
    expect(resolveMemorySystemPrompt(undefined)).toBe(MEMORY_SYSTEM_PROMPT);
  });

  it('returns the child variant when readOnlyState is true (fact writes OK, no hot)', () => {
    // Child sessions (readOnlyState=true, readOnlyMemory=false/undefined) have
    // memory_search + memory_update(target:"fact"). They get MEMORY_SYSTEM_PROMPT_READONLY.
    expect(resolveMemorySystemPrompt(false, true)).toBe(MEMORY_SYSTEM_PROMPT_READONLY);
    expect(resolveMemorySystemPrompt(undefined, true)).toBe(MEMORY_SYSTEM_PROMPT_READONLY);
  });

  it('returns the search-only variant when readOnlyMemory is true (recon: no memory_update)', () => {
    // Recon children (readOnlyMemory=true) have only memory_search. They must
    // NOT see a prompt that advertises memory_update.
    expect(resolveMemorySystemPrompt(true)).toBe(MEMORY_SYSTEM_PROMPT_SEARCH_ONLY);
    expect(resolveMemorySystemPrompt(true, false)).toBe(MEMORY_SYSTEM_PROMPT_SEARCH_ONLY);
    expect(resolveMemorySystemPrompt(true, true)).toBe(MEMORY_SYSTEM_PROMPT_SEARCH_ONLY);
  });

  it('the child variant omits the write-guidance section but keeps read guidance', () => {
    // The full prompt has a dedicated write section; the child variant must
    // not (it only mentions the write tools to say they are unavailable).
    expect(MEMORY_SYSTEM_PROMPT).toContain('## Writing memory');
    expect(MEMORY_SYSTEM_PROMPT_READONLY).not.toContain('## Writing memory');
    expect(MEMORY_SYSTEM_PROMPT_READONLY).not.toContain('## Procedures');
    expect(MEMORY_SYSTEM_PROMPT_READONLY).toContain('memory_update');
  });

  it('the search-only variant does not advertise memory_update at all', () => {
    expect(MEMORY_SYSTEM_PROMPT_SEARCH_ONLY).not.toContain('memory_update');
    expect(MEMORY_SYSTEM_PROMPT_SEARCH_ONLY).toContain('memory_search');
    expect(MEMORY_SYSTEM_PROMPT_SEARCH_ONLY).toContain('read-only');
  });
});

describe('resolveToolSystemPrompt — unnamed worker dedupe (#3359)', () => {
  it('returns empty string for an unnamed worker (isUnnamedWorker=true)', () => {
    // TOOL_SYSTEM_PROMPT_BASE is already embedded in UNNAMED_SUBAGENT_WORKER_PROMPT
    // (via composeUnnamedWorkerPrompt → systemPrompt). Prepending toolBase again
    // duplicates it. The provider skips the empty string so no leading blank line
    // appears in the assembled prompt.
    expect(resolveToolSystemPrompt(false, true)).toBe('');
    expect(resolveToolSystemPrompt(undefined, true)).toBe('');
  });

  it('isUnnamedWorker takes priority over isSkillDispatch', () => {
    // Defensive: the combination should not arise in production, but if it does
    // the no-double-base rule wins over the skill-dispatch base-only rule.
    expect(resolveToolSystemPrompt(true, true)).toBe('');
  });

  it('isUnnamedWorker=false/undefined does not change existing behaviour', () => {
    expect(resolveToolSystemPrompt(false, false)).toBe(TOOL_SYSTEM_PROMPT);
    expect(resolveToolSystemPrompt(false, undefined)).toBe(TOOL_SYSTEM_PROMPT);
    expect(resolveToolSystemPrompt(true, false)).toBe(TOOL_SYSTEM_PROMPT_BASE);
    expect(resolveToolSystemPrompt(true, undefined)).toBe(TOOL_SYSTEM_PROMPT_BASE);
  });

  it('TOOL_SYSTEM_PROMPT_BASE appears exactly once in an unnamed worker composed prompt', () => {
    // This is the core regression guard: the assembled text the provider sends
    // to the model must contain TOOL_SYSTEM_PROMPT_BASE exactly once — once from
    // the embedded UNNAMED_SUBAGENT_WORKER_PROMPT (via composeUnnamedWorkerPrompt),
    // and zero times from the provider's toolBase slot (which is now '').
    const assembled = composeUnnamedWorkerPrompt(undefined);
    const occurrences = assembled.split(TOOL_SYSTEM_PROMPT_BASE).length - 1;
    expect(occurrences).toBe(1);
  });

  it('TOOL_SYSTEM_PROMPT_BASE appears exactly once when an overlay is appended', () => {
    const assembled = composeUnnamedWorkerPrompt('Use pnpm only.');
    const occurrences = assembled.split(TOOL_SYSTEM_PROMPT_BASE).length - 1;
    expect(occurrences).toBe(1);
  });

  it('named agents and root sessions are unaffected: resolveToolSystemPrompt returns the full compound', () => {
    // isUnnamedWorker is not set for named agents or top-level sessions.
    expect(resolveToolSystemPrompt(false, undefined)).toBe(TOOL_SYSTEM_PROMPT);
    expect(resolveToolSystemPrompt(undefined, undefined)).toBe(TOOL_SYSTEM_PROMPT);
    // Skill-dispatch sub-agents return base-only (unchanged).
    expect(resolveToolSystemPrompt(true, undefined)).toBe(TOOL_SYSTEM_PROMPT_BASE);
  });
});
