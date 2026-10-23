/**
 * Tests for helpers exported from template-engine.templates-density.ts
 *
 * Coverage:
 *   - rootCauseFromClusterKey maps known patterns correctly
 *   - rootCauseFromClusterKey returns 'unknown' for unrecognised keys
 *   - likelyFilesForTool names the handler file first for a known tool
 *   - likelyFilesForTool always includes dispatcher.ts
 *   - toolFailureDensityTemplate fixSketch mentions errorHead and subagent journal
 *   - toolFailureDensityTemplate fixSketch embeds the tool name in Option A
 *   - toolFailureDensityTemplate fixSketch does NOT claim traces lack args
 */

import { describe, it, expect } from 'vitest';
import {
  rootCauseFromClusterKey,
  likelyFilesForTool,
  toolFailureDensityTemplate,
} from './template-engine.templates-density.js';
import type { FailureCard } from '../schemas.js';

function makeToolCard(toolName: string, extra: Record<string, unknown> = {}): FailureCard {
  return {
    schemaVersion: 1,
    slug: `tool-failure-density-${toolName}-aabbcc`,
    title: `'${toolName}' tool high failure rate`,
    pattern: 'tool-failure-density',
    severity: 'medium',
    status: 'open',
    firstSeen: '2026-05-22T10:00:00.000Z',
    lastSeen: '2026-05-22T10:00:00.000Z',
    occurrenceCount: 3,
    evidence: [],
    notes: [],
    detail: {
      detector: 'tool-failure-density@v2',
      toolName,
      totalCalls: 10,
      failureCount: 3,
      failureRate: 0.3,
      truncatedFailureCount: 0,
      sessionIds: ['sess-abc123'],
      ...extra,
    },
  };
}

describe('rootCauseFromClusterKey', () => {
  it('returns hook-overreach for block/permission patterns', () => {
    expect(rootCauseFromClusterKey('command blocked by risk classifier')).toBe('hook-overreach');
    expect(rootCauseFromClusterKey('permission denied reading file')).toBe('hook-overreach');
    expect(rootCauseFromClusterKey('not allowed by allowlist')).toBe('hook-overreach');
  });

  it('returns schema-too-strict for validation/schema patterns', () => {
    expect(rootCauseFromClusterKey('invalid input: missing required field')).toBe('schema-too-strict');
    expect(rootCauseFromClusterKey('validation error at path')).toBe('schema-too-strict');
    expect(rootCauseFromClusterKey('parse error: unexpected token')).toBe('schema-too-strict');
  });

  it('returns tool-output-shape for not-found/ENOENT patterns', () => {
    expect(rootCauseFromClusterKey('enoent no such file')).toBe('tool-output-shape');
    expect(rootCauseFromClusterKey('file not found at path')).toBe('tool-output-shape');
    expect(rootCauseFromClusterKey('cannot find module')).toBe('tool-output-shape');
  });

  it('returns timeout-too-low for timeout patterns', () => {
    expect(rootCauseFromClusterKey('timed out after <nms>')).toBe('timeout-too-low');
    expect(rootCauseFromClusterKey('deadline exceeded')).toBe('timeout-too-low');
  });

  it('returns unknown for unrecognised keys', () => {
    expect(rootCauseFromClusterKey('something completely different')).toBe('unknown');
    expect(rootCauseFromClusterKey('<empty>')).toBe('unknown');
    expect(rootCauseFromClusterKey('')).toBe('unknown');
  });
});

describe('likelyFilesForTool', () => {
  it('puts the named handler file first with high confidence', () => {
    const files = likelyFilesForTool('bash');
    expect(files[0]!.path).toBe('src/agent/tools/handlers/bash.ts');
    expect(files[0]!.confidence).toBe('high');
  });

  it('always includes dispatcher.ts', () => {
    const files = likelyFilesForTool('grep');
    const paths = files.map((f) => f.path);
    expect(paths.some((p) => p.includes('dispatcher.ts'))).toBe(true);
  });

  it('skips the handler-specific entry for unknown/empty tool names', () => {
    const files = likelyFilesForTool('');
    const paths = files.map((f) => f.path);
    expect(paths.every((p) => !p.endsWith('.ts') || p.includes('dispatcher') || p.includes('tool-failure-density'))).toBe(true);
  });
});

describe('toolFailureDensityTemplate — fixSketch', () => {
  it('mentions errorHead', () => {
    const sketch = toolFailureDensityTemplate.fixSketch(makeToolCard('bash'));
    expect(sketch).toContain('errorHead');
  });

  it('mentions subagent journal', () => {
    const sketch = toolFailureDensityTemplate.fixSketch(makeToolCard('bash'));
    expect(sketch.toLowerCase()).toContain('subagent');
  });

  it('does NOT claim that traces lack args or that args are unrecoverable', () => {
    const sketch = toolFailureDensityTemplate.fixSketch(makeToolCard('git-read'));
    expect(sketch).not.toContain('does not capture tool args');
    expect(sketch).not.toContain('unrecoverable');
  });

  it('embeds the tool name in the Option A handler path', () => {
    const sketch = toolFailureDensityTemplate.fixSketch(makeToolCard('wait-for'));
    expect(sketch).toContain('handlers/wait-for.ts');
  });

  it('two different tools produce different fixSketches', () => {
    const a = toolFailureDensityTemplate.fixSketch(makeToolCard('bash'));
    const b = toolFailureDensityTemplate.fixSketch(makeToolCard('git-read'));
    expect(a).not.toBe(b);
  });
});
