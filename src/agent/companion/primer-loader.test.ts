import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadCompanionPrimer,
  injectCompanionPrimer,
  MAX_PRIMER_CHARS,
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

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'afk-primer-'));
    delete process.env[ENV];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env[ENV];
    else process.env[ENV] = prev;
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
});
