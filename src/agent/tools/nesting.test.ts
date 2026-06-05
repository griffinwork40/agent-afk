import { describe, expect, it } from 'vitest';
import {
  CHILD_ALLOWED_TOOLS,
  RECON_ALLOWED_TOOLS,
  DEFAULT_READ_ONLY_SKILLS,
} from './nesting.js';
import { checkToolPermission } from './permissions.js';

describe('CHILD_ALLOWED_TOOLS', () => {
  it("includes 'memory_search'", () => {
    expect(CHILD_ALLOWED_TOOLS).toContain('memory_search');
  });

  it("does NOT include 'memory_update'", () => {
    // memory_update with target:"hot" mutates HOT.md — the system prompt of every
    // future session. Blast radius is too large for unsupervised sub-agent writes.
    expect(CHILD_ALLOWED_TOOLS).not.toContain('memory_update');
  });

  it("does NOT include 'procedure_write'", () => {
    // procedure_write is a write path; per-skill opt-in via a
    // buildPhaseRestrictedProvider-style builder is the intended route.
    expect(CHILD_ALLOWED_TOOLS).not.toContain('procedure_write');
  });

  it("includes 'agent' and 'skill'", () => {
    expect(CHILD_ALLOWED_TOOLS).toContain('agent');
    expect(CHILD_ALLOWED_TOOLS).toContain('skill');
  });

  it("does NOT include 'compose'", () => {
    // compose is excluded to prevent unbounded DAG fan-out from child nodes.
    expect(CHILD_ALLOWED_TOOLS).not.toContain('compose');
  });
});

describe('RECON_ALLOWED_TOOLS (read-only skill child allowlist)', () => {
  it("EXCLUDES 'write_file' and 'edit_file' (the file-mutation tools)", () => {
    // This is the tool half of read-only-skill enforcement: a read-only skill's
    // forked child cannot mutate files because these tools are not in the
    // allowlist `checkToolPermission` consults.
    expect(RECON_ALLOWED_TOOLS).not.toContain('write_file');
    expect(RECON_ALLOWED_TOOLS).not.toContain('edit_file');
  });

  it("INCLUDES 'bash' (read-only recon needs git status/log/diff)", () => {
    // bash is admitted but gated by the dispatcher's readOnlyBash classifier —
    // mutating bash is blocked at execution time, read-only bash passes.
    expect(RECON_ALLOWED_TOOLS).toContain('bash');
  });

  it("INCLUDES 'agent' and 'skill' (surveyor fan-out)", () => {
    expect(RECON_ALLOWED_TOOLS).toContain('agent');
    expect(RECON_ALLOWED_TOOLS).toContain('skill');
  });

  it("INCLUDES the core read tools", () => {
    for (const t of ['read_file', 'grep', 'glob', 'list_directory', 'web_scrape', 'memory_search']) {
      expect(RECON_ALLOWED_TOOLS).toContain(t);
    }
  });

  it("INCLUDES 'get_runtime_state' (via AWARENESS_TOOL_NAMES)", () => {
    expect(RECON_ALLOWED_TOOLS).toContain('get_runtime_state');
  });

  it('EXCLUDES side-effecting + environment tools', () => {
    for (const t of [
      'send_telegram',
      'terminal_font_size',
      'ask_question',
      'browser_open',
      'browser_act',
      'create_schedule',
      'cancel_schedule',
    ]) {
      expect(RECON_ALLOWED_TOOLS).not.toContain(t);
    }
  });

  it('the allowlist actually DENIES write_file / edit_file through checkToolPermission', () => {
    // Close the loop: the dispatcher's permission gate is what enforces the
    // allowlist, and it reads exactly this array. A read-only skill's child
    // provider is constructed with `permissions.allowedTools = RECON_ALLOWED_TOOLS`.
    const permissions = { allowedTools: [...RECON_ALLOWED_TOOLS] };
    expect(checkToolPermission('write_file', permissions).allowed).toBe(false);
    expect(checkToolPermission('edit_file', permissions).allowed).toBe(false);
    // ...and ALLOWS the recon tools.
    expect(checkToolPermission('read_file', permissions).allowed).toBe(true);
    expect(checkToolPermission('bash', permissions).allowed).toBe(true);
    expect(checkToolPermission('agent', permissions).allowed).toBe(true);
  });
});

describe('DEFAULT_READ_ONLY_SKILLS', () => {
  it("contains 'ground-state'", () => {
    expect(DEFAULT_READ_ONLY_SKILLS.has('ground-state')).toBe(true);
  });

  it('does not contain an arbitrary skill name', () => {
    expect(DEFAULT_READ_ONLY_SKILLS.has('mint')).toBe(false);
  });
});
