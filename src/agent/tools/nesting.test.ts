import { describe, expect, it } from 'vitest';
import { CHILD_ALLOWED_TOOLS } from './nesting.js';

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
