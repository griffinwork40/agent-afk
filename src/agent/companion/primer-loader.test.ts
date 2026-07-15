import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadCompanionPrimer,
  injectCompanionPrimer,
  MAX_PRIMER_CHARS,
  MAX_PRIMER_FILE_BYTES,
} from './primer-loader.js';
import type { AgentConfig } from '../types/config-types.js';

const ENV = 'AFK_COMPANION_PRIMER';

function baseConfig(systemPrompt?: AgentConfig['systemPrompt']): AgentConfig {
  return {
    model: 'sonnet',
    maxTokens: 1000,
    temperature: 1,
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
  } as AgentConfig;
}

describe('companion primer-loader', () => {
  let dir: string;
  const prev = process.env[ENV];
  const prevDebug = process.env['AFK_DEBUG'];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'afk-primer-'));
    delete process.env[ENV];
    delete process.env['AFK_DEBUG'];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env[ENV];
    else process.env[ENV] = prev;
    if (prevDebug === undefined) delete process.env['AFK_DEBUG'];
    else process.env['AFK_DEBUG'] = prevDebug;
  });

  // ── optional (default off) ───────────────────────────────────────────────
  it('is a no-op when the env var is unset', () => {
    const cfg = baseConfig('BASE PROMPT');
    expect(loadCompanionPrimer()).toBeNull();
    expect(injectCompanionPrimer(cfg)).toEqual(cfg);
  });

  it('is a no-op when the env var is empty / whitespace', () => {
    process.env[ENV] = '   ';
    const cfg = baseConfig('BASE PROMPT');
    expect(loadCompanionPrimer()).toBeNull();
    expect(injectCompanionPrimer(cfg)).toEqual(cfg);
  });

  it('is a no-op (no throw) when the path does not exist', () => {
    process.env[ENV] = join(dir, 'does-not-exist.md');
    const cfg = baseConfig('BASE PROMPT');
    expect(loadCompanionPrimer()).toBeNull();
    expect(injectCompanionPrimer(cfg)).toEqual(cfg);
  });

  it('is a no-op (no throw) when the path is a directory — proves no repo walk', () => {
    const sub = join(dir, 'a-directory');
    mkdirSync(sub);
    writeFileSync(join(sub, 'inner.md'), 'should never be read');
    process.env[ENV] = sub;
    const cfg = baseConfig('BASE PROMPT');
    expect(loadCompanionPrimer()).toBeNull();
    expect(injectCompanionPrimer(cfg)).toEqual(cfg);
  });

  it('is a no-op when the file is whitespace-only', () => {
    const p = join(dir, 'blank.md');
    writeFileSync(p, '\n  \n\t');
    process.env[ENV] = p;
    expect(loadCompanionPrimer()).toBeNull();
    expect(injectCompanionPrimer(baseConfig('B'))).toEqual(baseConfig('B'));
  });

  // ── opt-in ─────────────────────────────────────────────────────────────--
  it('appends a fenced, framed block after a string system prompt', () => {
    const p = join(dir, 'primer.md');
    writeFileSync(p, 'EXPERIMENT STATUS: day 1');
    process.env[ENV] = p;

    const out = injectCompanionPrimer(baseConfig('BASE PROMPT'));
    const sp = out.systemPrompt as string;

    expect(sp.startsWith('BASE PROMPT')).toBe(true); // existing prompt stays first
    expect(sp).toContain('<companion-primer source="opt-in; reflections, not facts">');
    expect(sp).toContain('</companion-primer>');
    expect(sp).toContain('LOWER-AUTHORITY'); // code-controlled framing present
    expect(sp).toContain('reflection or hypothesis, never an established fact');
    expect(sp).toContain('EXPERIMENT STATUS: day 1');
    // primer block is APPENDED (comes after the base prompt)
    expect(sp.indexOf('BASE PROMPT')).toBeLessThan(sp.indexOf('<companion-primer'));
  });

  it('sets the system prompt to the block when none exists', () => {
    const p = join(dir, 'primer.md');
    writeFileSync(p, 'hello');
    process.env[ENV] = p;

    const out = injectCompanionPrimer(baseConfig(undefined));
    const sp = out.systemPrompt as string;
    expect(sp.startsWith('<companion-primer')).toBe(true);
    expect(sp).toContain('hello');
  });

  it('appends to the preset append field without dropping it', () => {
    const p = join(dir, 'primer.md');
    writeFileSync(p, 'PRIMER BODY');
    process.env[ENV] = p;

    const out = injectCompanionPrimer(
      baseConfig({ type: 'preset', preset: 'claude_code', append: 'EXISTING' }),
    );
    const sp = out.systemPrompt as { type: 'preset'; append: string };
    expect(sp.type).toBe('preset');
    expect(sp.append).toContain('EXISTING');
    expect(sp.append).toContain('<companion-primer');
    expect(sp.append.indexOf('EXISTING')).toBeLessThan(sp.append.indexOf('<companion-primer'));
  });

  // ── bounded ───────────────────────────────────────────────────────────--
  it('hard-caps oversized content and emits an auditable truncation marker', () => {
    const huge = 'x'.repeat(MAX_PRIMER_CHARS + 5000);
    const p = join(dir, 'huge.md');
    writeFileSync(p, huge);
    process.env[ENV] = p;

    const out = injectCompanionPrimer(baseConfig('BASE'));
    const sp = out.systemPrompt as string;

    expect(sp).toContain(`[…companion primer truncated at ${MAX_PRIMER_CHARS} chars…]`);
    // The embedded run of primer content is exactly the cap — never the full file.
    // (Take the LONGEST run: the framing line itself contains incidental 'x's.)
    const longestRun = Math.max(...(sp.match(/x+/g) ?? ['']).map((s) => s.length));
    expect(longestRun).toBe(MAX_PRIMER_CHARS);
    expect(longestRun).toBeLessThan(huge.length);
  });

  it('does not truncate content at or under the cap', () => {
    const exact = 'y'.repeat(MAX_PRIMER_CHARS);
    const p = join(dir, 'exact.md');
    writeFileSync(p, exact);
    process.env[ENV] = p;

    const sp = injectCompanionPrimer(baseConfig('BASE')).systemPrompt as string;
    expect(sp).not.toContain('truncated at');
    expect(sp).toContain(exact);
  });

  // ── tag-injection guard ──────────────────────────────────────────────────
  it('strips nested companion-primer tags from file content', () => {
    const p = join(dir, 'nested.md');
    writeFileSync(p, 'before <companion-primer>INJECTED</companion-primer> after');
    process.env[ENV] = p;

    const sp = injectCompanionPrimer(baseConfig('BASE')).systemPrompt as string;
    // Exactly one opening + one closing fence — the nested ones were stripped.
    expect((sp.match(/<companion-primer/g) ?? []).length).toBe(1);
    expect((sp.match(/<\/companion-primer>/g) ?? []).length).toBe(1);
    expect(sp).toContain('before INJECTED after'); // text kept, tags removed
  });

  // ── placement relative to hot memory (append => primer lands last) ─────────
  it('lands after an existing cross-session-memory block (lowest salience)', () => {
    const p = join(dir, 'primer.md');
    writeFileSync(p, 'PRIMER');
    process.env[ENV] = p;

    // Simulate a config already carrying a hot-memory block + base prompt,
    // as it would after injectHotMemory ran first.
    const withHot = baseConfig('<cross-session-memory>HOT</cross-session-memory>\n\nFRAMEWORK BASE');
    const sp = injectCompanionPrimer(withHot).systemPrompt as string;
    expect(sp.indexOf('<cross-session-memory>')).toBeLessThan(sp.indexOf('<companion-primer'));
    expect(sp.indexOf('FRAMEWORK BASE')).toBeLessThan(sp.indexOf('<companion-primer'));
  });

  it('does not mutate the input config object', () => {
    const p = join(dir, 'primer.md');
    writeFileSync(p, 'PRIMER');
    process.env[ENV] = p;
    const cfg = baseConfig('BASE');
    const out = injectCompanionPrimer(cfg);
    expect(cfg.systemPrompt).toBe('BASE'); // original untouched
    expect(out).not.toBe(cfg);
  });

  // ── read bound (M1): stat-guard the read BEFORE buffering the file ─────────
  it('skips a file larger than MAX_PRIMER_FILE_BYTES without reading it', () => {
    const p = join(dir, 'oversized.md');
    writeFileSync(p, 'z'.repeat(MAX_PRIMER_FILE_BYTES + 1));
    process.env[ENV] = p;
    expect(loadCompanionPrimer()).toBeNull();
    expect(injectCompanionPrimer(baseConfig('BASE'))).toEqual(baseConfig('BASE'));
  });

  it('still reads and truncates a long-but-reasonable file under the byte cap', () => {
    // Over the CHAR cap but well under the BYTE cap ⇒ must still be read + truncated,
    // proving the read-size guard did not regress the prompt-cost truncation path.
    const chars = MAX_PRIMER_CHARS + 2000;
    expect(chars).toBeLessThan(MAX_PRIMER_FILE_BYTES); // ascii ⇒ 1 byte/char
    const p = join(dir, 'longish.md');
    writeFileSync(p, 'q'.repeat(chars));
    process.env[ENV] = p;
    const sp = injectCompanionPrimer(baseConfig('BASE')).systemPrompt as string;
    expect(sp).toContain(`[…companion primer truncated at ${MAX_PRIMER_CHARS} chars…]`);
  });

  // ── diagnosability (L2): AFK_DEBUG surfaces the failure reason on stderr ───
  it('is silent on a failed load by default (no AFK_DEBUG)', () => {
    process.env[ENV] = join(dir, 'missing.md');
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(loadCompanionPrimer()).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('surfaces the failed path on stderr when AFK_DEBUG is set', () => {
    const missing = join(dir, 'missing.md');
    process.env[ENV] = missing;
    process.env['AFK_DEBUG'] = '1';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(loadCompanionPrimer()).toBeNull();
      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('companion-primer');
      expect(output).toContain(missing);
    } finally {
      spy.mockRestore();
    }
  });

  it('logs a diagnostic naming the byte cap when skipping an oversized file (AFK_DEBUG)', () => {
    const p = join(dir, 'oversized.md');
    writeFileSync(p, 'z'.repeat(MAX_PRIMER_FILE_BYTES + 1));
    process.env[ENV] = p;
    process.env['AFK_DEBUG'] = '1';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(loadCompanionPrimer()).toBeNull();
      const output = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('skipped');
      expect(output).toContain(String(MAX_PRIMER_FILE_BYTES));
    } finally {
      spy.mockRestore();
    }
  });
});
