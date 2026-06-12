/**
 * Tests for `afk migrate` pure helpers: normalizeBinary, buildImportBlock,
 * and writeImportFrom. Uses an injectable tmp dir so nothing touches real state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { normalizeBinary, buildImportBlock, writeImportFrom } from './migrate.js';
import type { DetectedSource } from '../../config/import-sources.js';

let tmp: string;

beforeEach(() => {
  tmp = join(tmpdir(), `afk-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

// ── helpers ──────────────────────────────────────────────────────────────────

function makeSource(
  binary: 'claude-code' | 'codex',
  opts: Partial<Pick<DetectedSource, 'plugins' | 'skills' | 'mcpServers' | 'mcpFormat'>> = {},
): DetectedSource {
  return {
    binary,
    label: binary === 'claude-code' ? 'Claude Code' : 'Codex',
    present: true,
    plugins: opts.plugins ?? [],
    skills: opts.skills ?? [],
    mcpServers: opts.mcpServers ?? [],
    mcpConfigPath: null,
    mcpFormat: opts.mcpFormat ?? 'json',
  };
}

function configPath(): string {
  return join(tmp, 'afk.config.json');
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(), 'utf-8')) as Record<string, unknown>;
}

// ── normalizeBinary ───────────────────────────────────────────────────────────

describe('normalizeBinary', () => {
  it('returns null for undefined', () => {
    expect(normalizeBinary(undefined)).toBeNull();
  });

  it('returns null for unknown binary names', () => {
    expect(normalizeBinary('cursor')).toBeNull();
    expect(normalizeBinary('aider')).toBeNull();
    expect(normalizeBinary('')).toBeNull();
  });

  it('recognizes claude-code', () => {
    expect(normalizeBinary('claude-code')).toBe('claude-code');
  });

  it('recognizes codex', () => {
    expect(normalizeBinary('codex')).toBe('codex');
  });

  it('trims whitespace before matching', () => {
    expect(normalizeBinary('  claude-code  ')).toBe('claude-code');
    expect(normalizeBinary('  codex  ')).toBe('codex');
  });

  it('lowercases before matching', () => {
    expect(normalizeBinary('Claude-Code')).toBe('claude-code');
    expect(normalizeBinary('CODEX')).toBe('codex');
  });
});

// ── buildImportBlock ──────────────────────────────────────────────────────────

describe('buildImportBlock', () => {
  it('sets plugins/skills false when counts are zero', () => {
    const block = buildImportBlock([makeSource('claude-code')], false);
    expect(block['claude-code']).toEqual({ plugins: false, skills: false, mcp: false });
  });

  it('sets plugins true when plugins are present', () => {
    const src = makeSource('claude-code', { plugins: [{ name: 'p1', path: '/p1' }] });
    const block = buildImportBlock([src], false);
    expect(block['claude-code']?.plugins).toBe(true);
    expect(block['claude-code']?.skills).toBe(false);
  });

  it('sets skills true when skills are present', () => {
    const src = makeSource('claude-code', { skills: [{ name: 's1', path: '/s1' }] });
    const block = buildImportBlock([src], false);
    expect(block['claude-code']?.skills).toBe(true);
    expect(block['claude-code']?.plugins).toBe(false);
  });

  it('sets mcp true only when includeMcp=true AND format=json AND servers>0', () => {
    const src = makeSource('claude-code', {
      mcpServers: [{ name: 'gh', command: 'npx gh' }],
      mcpFormat: 'json',
    });
    expect(buildImportBlock([src], true)['claude-code']?.mcp).toBe(true);
    expect(buildImportBlock([src], false)['claude-code']?.mcp).toBe(false);
  });

  it('keeps mcp false for a toml-format source even with --mcp', () => {
    const src = makeSource('codex', {
      mcpServers: [{ name: 'fs', command: 'mcp-fs' }],
      mcpFormat: 'toml',
    });
    expect(buildImportBlock([src], true)['codex']?.mcp).toBe(false);
  });

  it('keeps mcp false when servers list is empty', () => {
    const src = makeSource('claude-code', { mcpServers: [], mcpFormat: 'json' });
    expect(buildImportBlock([src], true)['claude-code']?.mcp).toBe(false);
  });

  it('handles multiple targets', () => {
    const claude = makeSource('claude-code', { plugins: [{ name: 'p', path: '/p' }] });
    const codex = makeSource('codex', { skills: [{ name: 's', path: '/s' }] });
    const block = buildImportBlock([claude, codex], false);
    expect(block['claude-code']?.plugins).toBe(true);
    expect(block['codex']?.skills).toBe(true);
  });
});

// ── writeImportFrom ───────────────────────────────────────────────────────────

describe('writeImportFrom', () => {
  it('creates a fresh config file with the importFrom block', () => {
    const p = configPath();
    writeImportFrom(p, { 'claude-code': { plugins: true, skills: true, mcp: false } });
    const cfg = readConfig();
    expect(cfg['importFrom']).toEqual({ 'claude-code': { plugins: true, skills: true, mcp: false } });
  });

  it('additive re-run: does NOT clear a prior mcp:true when new block has mcp:false', () => {
    const p = configPath();
    // Seed: claude-code fully enabled
    writeFileSync(
      p,
      JSON.stringify({ importFrom: { 'claude-code': { plugins: true, skills: true, mcp: true } } }) + '\n',
    );
    // Re-run with a block that computes mcp:false (e.g. no --mcp flag)
    writeImportFrom(p, { 'claude-code': { plugins: true, skills: true, mcp: false } });
    const result = readConfig()['importFrom'] as Record<string, { mcp: boolean }>;
    expect(result['claude-code']?.mcp).toBe(true); // must NOT be cleared
  });

  it('additive re-run: does NOT clear a prior plugins:true when new block has plugins:false', () => {
    const p = configPath();
    writeFileSync(
      p,
      JSON.stringify({ importFrom: { 'claude-code': { plugins: true, skills: false, mcp: false } } }) + '\n',
    );
    writeImportFrom(p, { 'claude-code': { plugins: false, skills: false, mcp: false } });
    const result = readConfig()['importFrom'] as Record<string, { plugins: boolean }>;
    expect(result['claude-code']?.plugins).toBe(true);
  });

  it('normalizes a prior shorthand true before re-merging the SAME binary so implied trues are never dropped', () => {
    const p = configPath();
    // Prior: shorthand `true` for claude-code (implies plugins+skills+mcp all on).
    writeFileSync(p, JSON.stringify({ importFrom: { 'claude-code': true } }) + '\n');
    // Re-run records claude-code with only plugins detected. A naive
    // { ...true, ...new } merge would DROP the shorthand's implied skills+mcp;
    // normalize-before-OR-merge must preserve them.
    writeImportFrom(p, { 'claude-code': { plugins: true, skills: false, mcp: false } });
    const result = readConfig()['importFrom'] as Record<string, unknown>;
    const cc = result['claude-code'] as { plugins: boolean; skills: boolean; mcp: boolean };
    expect(cc.plugins).toBe(true);
    expect(cc.skills).toBe(true); // preserved from shorthand, not dropped
    expect(cc.mcp).toBe(true); // preserved from shorthand, not dropped
  });

  it('preserves untouched binaries verbatim (not in importBlock)', () => {
    const p = configPath();
    writeFileSync(
      p,
      JSON.stringify({ importFrom: { codex: { plugins: true, skills: false, mcp: false } } }) + '\n',
    );
    writeImportFrom(p, { 'claude-code': { plugins: true, skills: true, mcp: false } });
    const result = readConfig()['importFrom'] as Record<string, unknown>;
    expect(result['codex']).toEqual({ plugins: true, skills: false, mcp: false });
    expect(result['claude-code']).toEqual({ plugins: true, skills: true, mcp: false });
  });

  it('preserves unrelated top-level config keys (e.g. model)', () => {
    const p = configPath();
    writeFileSync(p, JSON.stringify({ model: 'sonnet', importFrom: {} }) + '\n');
    writeImportFrom(p, { 'claude-code': { plugins: true, skills: false, mcp: false } });
    const cfg = readConfig();
    expect(cfg['model']).toBe('sonnet');
  });

  it('throws on a malformed (non-JSON) existing config file', () => {
    const p = configPath();
    writeFileSync(p, '{ not valid json');
    expect(() =>
      writeImportFrom(p, { 'claude-code': { plugins: true, skills: false, mcp: false } }),
    ).toThrow('existing config is not valid JSON');
  });

  it('creates parent directories when they do not exist', () => {
    const nested = join(tmp, 'a', 'b', 'afk.config.json');
    writeImportFrom(nested, { 'claude-code': { plugins: true, skills: false, mcp: false } });
    expect(existsSync(nested)).toBe(true);
  });
});
