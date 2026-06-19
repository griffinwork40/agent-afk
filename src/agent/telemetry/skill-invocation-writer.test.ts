/**
 * Unit tests for the native AFK skill-invocation telemetry writer.
 *
 * Hermetic: every test that touches the filesystem uses a `mkdtempSync` dir
 * so no writes ever reach the real `~/.afk/`. The `writeSkillInvocation`
 * guard test additionally saves/restores `AFK_HOME` and asserts the file
 * does NOT exist after calling under vitest — proving the guard suppresses
 * real writes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildSkillInvocationRow,
  appendSkillInvocationTo,
  writeSkillInvocation,
} from './skill-invocation-writer.js';

// ---------------------------------------------------------------------------
// (a) buildSkillInvocationRow — pure, no I/O
// ---------------------------------------------------------------------------

describe('buildSkillInvocationRow', () => {
  it('includes required fields: ts, surface, event, skill_name, source', () => {
    const row = buildSkillInvocationRow({ skillName: 'mint' });

    expect(row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(row.surface).toBe('afk');
    expect(row.event).toBe('skill_invocation');
    expect(row.skill_name).toBe('mint');
    expect(row.source).toBe('native-runtime');
  });

  it('omits optional fields entirely when input is undefined (not null)', () => {
    const row = buildSkillInvocationRow({ skillName: 'diagnose' });

    // Assert the keys are absent, not null
    expect(Object.prototype.hasOwnProperty.call(row, 'session_id')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, 'trace_id')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, 'cwd')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, 'model')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, 'command')).toBe(false);
  });

  it('(1)(3) includes origin + actor when provided, alongside an unchanged surface:afk', () => {
    const row = buildSkillInvocationRow({ skillName: 'mint', origin: 'telegram', actor: 'main' });
    expect(row.origin).toBe('telegram');
    expect(row.actor).toBe('main');
    // The frozen provenance tag is a SEPARATE field; origin never overwrites it.
    expect(row.surface).toBe('afk');
  });

  it('(2) records actor:subagent for a skill dispatched from within a subagent', () => {
    const row = buildSkillInvocationRow({ skillName: 'review', origin: 'cli', actor: 'subagent' });
    expect(row.actor).toBe('subagent');
    expect(row.origin).toBe('cli');
  });

  it('(4) omits origin/actor when absent (back-compat), keeping surface:afk', () => {
    const row = buildSkillInvocationRow({ skillName: 'diagnose' });
    expect(Object.prototype.hasOwnProperty.call(row, 'origin')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, 'actor')).toBe(false);
    expect(row.surface).toBe('afk');
  });

  it('includes optional fields when provided', () => {
    const row = buildSkillInvocationRow({
      skillName: 'ship',
      sessionId: 'sess-abc',
      traceId: 'trace-xyz',
      cwd: '/tmp/myproject',
      model: 'claude-sonnet-4-5',
      command: '--verify',
    });

    expect(row.session_id).toBe('sess-abc');
    expect(row.trace_id).toBe('trace-xyz');
    expect(row.cwd).toBe('/tmp/myproject');
    expect(row.model).toBe('claude-sonnet-4-5');
    expect(row.command).toBe('--verify');
  });

  it('includes only the provided optional fields (partial subset)', () => {
    const row = buildSkillInvocationRow({
      skillName: 'gather',
      sessionId: 'sess-123',
      model: 'haiku',
    });

    expect(row.session_id).toBe('sess-123');
    expect(row.model).toBe('haiku');
    expect(Object.prototype.hasOwnProperty.call(row, 'trace_id')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, 'cwd')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, 'command')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (b) appendSkillInvocationTo — explicit dir, hermetic I/O
// ---------------------------------------------------------------------------

describe('appendSkillInvocationTo', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'afk-skill-inv-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates the file and writes a valid JSONL row', () => {
    const row = buildSkillInvocationRow({
      skillName: 'mint',
      sessionId: 'sess-1',
      model: 'sonnet',
    });

    appendSkillInvocationTo(tmp, row);

    const filePath = join(tmp, 'skill-invocations.jsonl');
    expect(existsSync(filePath)).toBe(true);

    const raw = readFileSync(filePath, 'utf8');
    const lines = raw.trim().split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed['surface']).toBe('afk');
    expect(parsed['event']).toBe('skill_invocation');
    expect(parsed['skill_name']).toBe('mint');
    expect(parsed['source']).toBe('native-runtime');
    expect(parsed['session_id']).toBe('sess-1');
    expect(parsed['model']).toBe('sonnet');
  });

  it('appends (two calls → two lines)', () => {
    const row1 = buildSkillInvocationRow({ skillName: 'mint' });
    const row2 = buildSkillInvocationRow({ skillName: 'ship' });

    appendSkillInvocationTo(tmp, row1);
    appendSkillInvocationTo(tmp, row2);

    const raw = readFileSync(join(tmp, 'skill-invocations.jsonl'), 'utf8');
    const lines = raw.trim().split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(first['skill_name']).toBe('mint');
    expect(second['skill_name']).toBe('ship');
  });

  it('does not throw when the dir is unwritable (e.g. parent is a file)', () => {
    // Construct a path whose parent component is actually a file → mkdirSync
    // will throw ENOTDIR, exercising the swallow-and-continue guarantee.
    const fileAsDir = join(tmp, 'i-am-a-file');
    // Write a regular file at the "dir" path
    appendSkillInvocationTo(tmp, buildSkillInvocationRow({ skillName: 'probe' })); // warm up parent
    const badFrameworkDir = join(tmp, 'skill-invocations.jsonl', 'nested');
    // skill-invocations.jsonl is now a file; using it as a parent is ENOTDIR
    const row = buildSkillInvocationRow({ skillName: 'test' });
    expect(() => appendSkillInvocationTo(badFrameworkDir, row)).not.toThrow();
    void fileAsDir; // suppress unused-var lint
  });
});

// ---------------------------------------------------------------------------
// (c) writeSkillInvocation guard — must be a no-op under vitest
// ---------------------------------------------------------------------------

describe('writeSkillInvocation guard', () => {
  const savedAfkHome = process.env['AFK_HOME'];

  afterEach(() => {
    // Restore AFK_HOME regardless of test outcome
    if (savedAfkHome === undefined) {
      delete process.env['AFK_HOME'];
    } else {
      process.env['AFK_HOME'] = savedAfkHome;
    }
  });

  it('does NOT write to skill-invocations.jsonl when running under vitest', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'afk-guard-'));
    try {
      // Point AFK_HOME at the tmp dir so if the guard fails, the file lands
      // there and our assertion catches it.
      process.env['AFK_HOME'] = tmp;

      writeSkillInvocation({ skillName: 'mint', sessionId: 'sess-guard-test' });

      const filePath = join(tmp, 'agent-framework', 'skill-invocations.jsonl');
      expect(existsSync(filePath)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
