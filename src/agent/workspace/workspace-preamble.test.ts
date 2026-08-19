/**
 * Tests for renderWorkspacePreamble and injectWorkspacePreamble (workspace-preamble.ts).
 *
 * @module agent/workspace/workspace-preamble.test
 */

import { describe, it, expect } from 'vitest';
import { renderWorkspacePreamble, injectWorkspacePreamble } from './workspace-preamble.js';
import type { WorkspaceEntry } from './workspace-store.js';
import type { AgentConfig } from '../types.js';

// ── Minimal stub for WorkspaceEntry ──────────────────────────────────────────

function makeEntry(overrides: Partial<WorkspaceEntry> = {}): WorkspaceEntry {
  return {
    id: 1,
    session_id: 'sess-1',
    type: 'finding',
    subject: null,
    content: 'The cache layer uses LRU eviction.',
    evidence: null,
    confidence: 1.0,
    agent_id: null,
    relates_to: null,
    relation_type: null,
    created_at: '2026-08-18T00:00:00.000Z',
    seq: 1,
    ...overrides,
  };
}

// ── renderWorkspacePreamble ───────────────────────────────────────────────────

describe('renderWorkspacePreamble', () => {
  it('renders header block', () => {
    const output = renderWorkspacePreamble([makeEntry()]);
    expect(output).toContain('# Workspace context');
    expect(output).toContain('workspace_publish');
  });

  it('renders entry id and type', () => {
    const output = renderWorkspacePreamble([makeEntry({ id: 7, type: 'decision' })]);
    expect(output).toContain('#7 Decision');
  });

  it('renders confidence', () => {
    const output = renderWorkspacePreamble([makeEntry({ confidence: 0.75 })]);
    expect(output).toContain('confidence: 0.75');
  });

  it('renders agent_id when present', () => {
    const output = renderWorkspacePreamble([makeEntry({ agent_id: 'my-agent' })]);
    expect(output).toContain('agent: my-agent');
  });

  it('does not render agent when absent', () => {
    const output = renderWorkspacePreamble([makeEntry({ agent_id: null })]);
    expect(output).not.toContain('agent:');
  });

  it('renders subject when present', () => {
    const output = renderWorkspacePreamble([makeEntry({ subject: 'auth refresh' })]);
    expect(output).toContain('Subject: auth refresh');
  });

  it('does not render subject line when null', () => {
    const output = renderWorkspacePreamble([makeEntry({ subject: null })]);
    expect(output).not.toContain('Subject:');
  });

  it('renders content', () => {
    const output = renderWorkspacePreamble([makeEntry({ content: 'Very important finding.' })]);
    expect(output).toContain('Very important finding.');
  });

  it('renders evidence refs when valid JSON array', () => {
    const output = renderWorkspacePreamble([
      makeEntry({ evidence: JSON.stringify(['src/auth.ts:42', 'src/utils.ts:10']) }),
    ]);
    expect(output).toContain('Evidence: src/auth.ts:42, src/utils.ts:10');
  });

  it('omits evidence block when evidence is null', () => {
    const output = renderWorkspacePreamble([makeEntry({ evidence: null })]);
    expect(output).not.toContain('Evidence:');
  });

  it('omits evidence block when evidence is empty array', () => {
    const output = renderWorkspacePreamble([
      makeEntry({ evidence: JSON.stringify([]) }),
    ]);
    expect(output).not.toContain('Evidence:');
  });

  it('omits evidence block on malformed JSON (silently)', () => {
    const output = renderWorkspacePreamble([makeEntry({ evidence: '{bad json' })]);
    expect(output).not.toContain('Evidence:');
  });

  it('renders relation when relates_to + relation_type present', () => {
    const output = renderWorkspacePreamble([
      makeEntry({
        relates_to: JSON.stringify([3, 5]),
        relation_type: 'supports',
      }),
    ]);
    expect(output).toContain('Relation: supports → #3, #5');
  });

  it('omits relation block when relates_to is null', () => {
    const output = renderWorkspacePreamble([makeEntry({ relates_to: null, relation_type: null })]);
    expect(output).not.toContain('Relation:');
  });

  it('renders dividers between entries', () => {
    const output = renderWorkspacePreamble([makeEntry({ id: 1 }), makeEntry({ id: 2 })]);
    // At least two '---' dividers expected
    const dividers = output.match(/^---$/gm);
    expect(dividers?.length).toBeGreaterThanOrEqual(2);
  });

  it('renders all valid entry types capitalised', () => {
    const types: WorkspaceEntry['type'][] = [
      'finding', 'evidence', 'hypothesis', 'decision', 'artifact', 'status',
    ];
    for (const type of types) {
      const output = renderWorkspacePreamble([makeEntry({ type })]);
      const capitalised = type[0]!.toUpperCase() + type.slice(1);
      expect(output).toContain(`#1 ${capitalised}`);
    }
  });
});

// ── injectWorkspacePreamble ───────────────────────────────────────────────────

describe('injectWorkspacePreamble', () => {
  const baseConfig: AgentConfig = { model: 'sonnet' };

  it('injects cold-start hint when entries is empty', () => {
    const result = injectWorkspacePreamble(baseConfig, []);
    expect(result).not.toBe(baseConfig);
    expect(result.model).toBe('sonnet');
    expect(result.systemPrompt).toContain('workspace_publish');
    expect(result.systemPrompt).toContain('No entries have been published yet');
  });

  it('does not mutate the input config', () => {
    const config: AgentConfig = { model: 'sonnet', systemPrompt: 'Hello' };
    injectWorkspacePreamble(config, [makeEntry()]);
    expect(config.systemPrompt).toBe('Hello');
  });

  it('injects into string systemPrompt with separator', () => {
    const config: AgentConfig = { model: 'sonnet', systemPrompt: 'You are helpful.' };
    const result = injectWorkspacePreamble(config, [makeEntry()]);
    expect(result.systemPrompt).toContain('You are helpful.');
    expect(result.systemPrompt).toContain('\n\n');
    expect(result.systemPrompt).toContain('# Workspace context');
  });

  it('sets preamble as systemPrompt when string is empty', () => {
    const config: AgentConfig = { model: 'sonnet', systemPrompt: '' };
    const result = injectWorkspacePreamble(config, [makeEntry()]);
    expect(result.systemPrompt).toContain('# Workspace context');
    expect((result.systemPrompt as string).startsWith('#')).toBe(true);
  });

  it('injects when no systemPrompt set', () => {
    const result = injectWorkspacePreamble(baseConfig, [makeEntry()]);
    expect(result.systemPrompt).toContain('# Workspace context');
  });

  it('appends to preset systemPrompt append field', () => {
    const config: AgentConfig = {
      model: 'sonnet',
      systemPrompt: { type: 'preset', promptId: 'repl', append: 'Existing append.' },
    };
    const result = injectWorkspacePreamble(config, [makeEntry()]);
    const sp = result.systemPrompt as { type: string; append: string };
    expect(sp.type).toBe('preset');
    expect(sp.append).toContain('Existing append.');
    expect(sp.append).toContain('# Workspace context');
  });

  it('sets append on preset when no prior append', () => {
    const config: AgentConfig = {
      model: 'sonnet',
      systemPrompt: { type: 'preset', promptId: 'repl' },
    };
    const result = injectWorkspacePreamble(config, [makeEntry()]);
    const sp = result.systemPrompt as { type: string; append: string };
    expect(sp.append).toContain('# Workspace context');
  });

  it('preserves all other config fields unchanged', () => {
    const config: AgentConfig = {
      model: 'haiku',
      systemPrompt: 'Hello',
      maxTokens: 512,
    };
    const result = injectWorkspacePreamble(config, [makeEntry()]);
    expect(result.model).toBe('haiku');
    expect(result.maxTokens).toBe(512);
  });
});
