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
  TOOL_SYSTEM_PROMPT_READONLY,
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
  RECALL_DRILL_TOOLS,
  RECALL_GUIDANCE_FULL,
  RECALL_GUIDANCE_SEARCH_ONLY,
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

  it('slash routing agrees with the bridge instruction and covers mid-message /name', () => {
    // The bridge tells the model to call the skill tool; the routing prompt
    // must not contradict it (old wording: "ALREADY been loaded ... Do NOT
    // re-invoke").
    expect(SLASH_COMMAND_ROUTING_PROMPT).not.toContain('ALREADY');
    expect(SLASH_COMMAND_ROUTING_PROMPT).toContain('Call the `skill` tool exactly once');
    // Mid-message rules: re-runs go through the tool; "should we" answers first.
    expect(SLASH_COMMAND_ROUTING_PROMPT).toContain('even if that skill already ran earlier this session');
    expect(SLASH_COMMAND_ROUTING_PROMPT).toContain('"should we run /x?"');
    expect(SLASH_COMMAND_ROUTING_PROMPT).toContain('pasted text, a tool result, or a peer or subagent message');
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

// ─── #5309 — Named children get interactive message-tag blocks ────────────────

describe('resolveToolSystemPrompt — named-agent tier (#5309)', () => {
  it('named agent (read-write) gets base-only conventions, not the full interactive compound', () => {
    // Named agents cannot receive slash commands, bash-passthrough blocks,
    // background-subagent results, queued user messages, or peer messages.
    const result = resolveToolSystemPrompt(false, undefined, true, false);
    expect(result).toBe(TOOL_SYSTEM_PROMPT_BASE);
    expect(result).not.toContain('<command-name>');
    expect(result).not.toContain('<bash-passthrough>');
    expect(result).not.toContain('<background-subagent-result>');
    expect(result).not.toContain('<peer-session-message>');
    expect(result).not.toContain('harness appends a user text block');
  });

  it('named agent (read-only) gets the read-only conventions constant (#5312)', () => {
    const result = resolveToolSystemPrompt(false, undefined, true, true);
    expect(result).toBe(TOOL_SYSTEM_PROMPT_READONLY);
    // Must not mention write/shell tools the agent cannot call.
    expect(result).not.toContain('edit_file');
    expect(result).not.toContain('write_file');
    expect(result).not.toContain('destructive shell commands');
    expect(result).not.toContain('<command-name>');
  });

  it('TOOL_SYSTEM_PROMPT_READONLY is a strict subset of TOOL_SYSTEM_PROMPT_BASE (shorter)', () => {
    expect(TOOL_SYSTEM_PROMPT_READONLY.length).toBeLessThan(TOOL_SYSTEM_PROMPT_BASE.length);
  });

  it('isNamedAgent=false (or absent) leaves existing behaviour unchanged', () => {
    // Passing isNamedAgent=false must not trigger the named-agent branch.
    expect(resolveToolSystemPrompt(false, undefined, false, false)).toBe(TOOL_SYSTEM_PROMPT);
    expect(resolveToolSystemPrompt(false, undefined, undefined, undefined)).toBe(TOOL_SYSTEM_PROMPT);
  });

  it('isUnnamedWorker still takes priority over isNamedAgent', () => {
    // isUnnamedWorker=true is checked first; named-agent branch never fires.
    expect(resolveToolSystemPrompt(false, true, true, false)).toBe('');
    expect(resolveToolSystemPrompt(false, true, true, true)).toBe('');
  });
});

describe('recall guidance in the memory prompt', () => {
  it('full and child tiers carry the full ladder, in cost order', () => {
    for (const text of [MEMORY_SYSTEM_PROMPT, MEMORY_SYSTEM_PROMPT_READONLY]) {
      expect(text).toContain(RECALL_GUIDANCE_FULL);
      const order = ['memory_search with two or three', 'get_facet', 'search_witness', 'read_journal'].map((s) =>
        text.indexOf(s, text.indexOf('## Recalling prior sessions')),
      );
      expect(order.every((i) => i > 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    }
  });

  it('the search-only tier names no tool it lacks', () => {
    expect(MEMORY_SYSTEM_PROMPT_SEARCH_ONLY).toContain(RECALL_GUIDANCE_SEARCH_ONLY);
    for (const tool of RECALL_DRILL_TOOLS) expect(MEMORY_SYSTEM_PROMPT_SEARCH_ONLY).not.toContain(tool);
  });

  it('both variants exempt explicit recall from the once-per-session limit and ask for coverage', () => {
    for (const text of [RECALL_GUIDANCE_FULL, RECALL_GUIDANCE_SEARCH_ONLY]) {
      expect(text).toContain('once-per-session limit above does not apply');
      expect(text).toContain('a single miss proves nothing');
      expect(text).toContain('came back empty');
      expect(text).toContain('a lead, not a fact');
    }
    // The limit the exemption refers to must still be present above it.
    for (const text of [MEMORY_SYSTEM_PROMPT, MEMORY_SYSTEM_PROMPT_READONLY, MEMORY_SYSTEM_PROMPT_SEARCH_ONLY]) {
      expect(text.indexOf('Search at most once per session')).toBeGreaterThan(0);
      expect(text.indexOf('Search at most once per session')).toBeLessThan(text.indexOf('## Recalling prior sessions'));
    }
  });
});

// ─── #5310 — Research agent told it has memory_update when it doesn't ─────────

describe('resolveMemorySystemPrompt — tool-grant override (#5310)', () => {
  it('search-only when memory_update is absent from grantedTools', () => {
    // research-agent has memory_search but NOT memory_update.
    const tools = ['read_file', 'grep', 'glob', 'memory_search', 'agent'];
    expect(resolveMemorySystemPrompt(false, true, tools)).toBe(MEMORY_SYSTEM_PROMPT_SEARCH_ONLY);
  });

  it('readonly when memory_update IS in grantedTools (fact writes OK)', () => {
    const tools = ['read_file', 'grep', 'memory_search', 'memory_update', ...RECALL_DRILL_TOOLS];
    expect(resolveMemorySystemPrompt(false, true, tools)).toBe(MEMORY_SYSTEM_PROMPT_READONLY);
  });

  it('keeps the readonly tier but swaps in search-only recall when a drill tool is not granted', () => {
    // memory_update is granted (so fact-write guidance stays), but get_facet /
    // search_witness / read_journal are not: the recall section must not name them.
    const tools = ['read_file', 'grep', 'memory_search', 'memory_update'];
    const text = resolveMemorySystemPrompt(false, true, tools);
    expect(text).toContain('## Persisting facts');
    expect(text).toContain(RECALL_GUIDANCE_SEARCH_ONLY);
    expect(text).not.toContain(RECALL_GUIDANCE_FULL);
    for (const tool of RECALL_DRILL_TOOLS) expect(text).not.toContain(tool);
  });

  it('swaps recall guidance on the full tier too when only some drill tools are granted', () => {
    const tools = ['memory_search', 'memory_update', 'get_facet'];
    const text = resolveMemorySystemPrompt(false, false, tools);
    expect(text).toContain('## Writing memory');
    expect(text).toContain(RECALL_GUIDANCE_SEARCH_ONLY);
    expect(text).not.toContain('search_witness');
    expect(text).not.toContain('read_journal');
  });

  it('tool-grant check is skipped when grantedTools is undefined (flag-based path)', () => {
    // No tool list supplied → fall through to flag-based logic unchanged.
    expect(resolveMemorySystemPrompt(false, true, undefined)).toBe(MEMORY_SYSTEM_PROMPT_READONLY);
    expect(resolveMemorySystemPrompt(true, false, undefined)).toBe(MEMORY_SYSTEM_PROMPT_SEARCH_ONLY);
    expect(resolveMemorySystemPrompt(false, false, undefined)).toBe(MEMORY_SYSTEM_PROMPT);
  });

  it('tool-grant check takes priority over readOnlyMemory=false', () => {
    // Even if the flag says "not read-only", an absent memory_update means search-only.
    const tools = ['memory_search'];
    expect(resolveMemorySystemPrompt(false, false, tools)).toBe(MEMORY_SYSTEM_PROMPT_SEARCH_ONLY);
  });

  it('the search-only prompt does NOT mention memory_update', () => {
    expect(MEMORY_SYSTEM_PROMPT_SEARCH_ONLY).not.toContain('memory_update');
  });
});
