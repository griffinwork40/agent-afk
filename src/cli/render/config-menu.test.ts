/**
 * Tests for the /config interactive settings menu (render/config-menu.ts).
 *
 * Pure helpers (categorisation, formatting, editor planning, validation) are
 * tested directly. The orchestrator is exercised against scripted fake overlays
 * + a recording io — no real compositor and no disk writes.
 */

import { describe, it, expect } from 'vitest';
import { runConfigMenu, type MenuOverlays, type MenuIo } from './config-menu.js';
import type { ConfigProvenance } from '../config/provenance.js';
import type { LiveApplyOutcome } from '../config/live-apply.js';
import {
  CATEGORY_ORDER,
  categoryOf,
  buildCategories,
  formatValue,
  keyRowLabel,
  editorFor,
  makeValidator,
} from './config-menu-model.js';
import { CONFIG_KEY_SPECS, getConfigKeySpec, type ConfigKeySpec } from '../../config/settable-keys.js';

// ── Fakes ────────────────────────────────────────────────────────────────────

class FakeOverlays implements MenuOverlays {
  pickCalls: Array<{ header: readonly string[]; options: readonly string[] }> = [];
  textCalls: Array<{ header: readonly string[]; initial: string; help: string }> = [];
  emits: string[] = [];
  lastValidator: ((v: string) => string | null) | null = null;
  private picks: Array<number | null>;
  private texts: Array<string | null>;

  constructor(picks: Array<number | null>, texts: Array<string | null> = []) {
    this.picks = [...picks];
    this.texts = [...texts];
  }

  async pick(header: readonly string[], options: readonly string[]): Promise<number | null> {
    this.pickCalls.push({ header, options });
    return this.picks.length > 0 ? this.picks.shift()! : null;
  }

  async editText(
    header: readonly string[],
    initial: string,
    help: string,
    validate: (v: string) => string | null,
  ): Promise<string | null> {
    this.textCalls.push({ header, initial, help });
    this.lastValidator = validate;
    return this.texts.length > 0 ? this.texts.shift()! : null;
  }

  emit(line: string): void {
    this.emits.push(line);
  }
}

class FakeIo implements MenuIo {
  writes: Array<{ path: string; value: string; human: boolean }> = [];
  throwOn: string | null = null;
  private specList: readonly ConfigKeySpec[];
  private values: Record<string, unknown>;

  constructor(specList: readonly ConfigKeySpec[], values: Record<string, unknown> = {}) {
    this.specList = specList;
    this.values = values;
  }

  specs(): readonly ConfigKeySpec[] {
    return this.specList;
  }

  current(path: string): unknown {
    return this.values[path];
  }

  write(path: string, rawValue: string, allowHuman: boolean): string {
    if (this.throwOn === path) throw new Error(`refused: ${path}`);
    this.writes.push({ path, value: rawValue, human: allowHuman });
    return rawValue;
  }
}

const TWO_KEY_SPECS: ConfigKeySpec[] = [
  { path: 'temperature', tier: 'agent', type: 'number', clamp: { min: 0, max: 2 }, description: 'Sampling temperature.' },
  { path: 'permissionMode', tier: 'human', type: 'enum', enumValues: ['default', 'plan'], description: 'Perm mode.' },
];

// ── Pure helpers ───────────────────────────────────────────────────────────

describe('categoryOf', () => {
  it('maps every CONFIG_KEY_SPECS path into a known category', () => {
    for (const spec of CONFIG_KEY_SPECS) {
      expect(CATEGORY_ORDER).toContain(categoryOf(spec.path));
    }
  });

  it('maps representative paths correctly', () => {
    expect(categoryOf('model')).toBe('Model & routing');
    expect(categoryOf('models.large')).toBe('Model & routing');
    expect(categoryOf('temperature')).toBe('Model & routing');
    expect(categoryOf('autoRouting.chat')).toBe('Model & routing');
    expect(categoryOf('interactive.suggestGhost')).toBe('Interactive');
    expect(categoryOf('telegram.notify.mode')).toBe('Telegram');
    expect(categoryOf('permissionMode')).toBe('Advanced');
    expect(categoryOf('daemon.task')).toBe('Advanced');
    expect(categoryOf('bgSummaries')).toBe('Session');
  });
});

describe('buildCategories', () => {
  it('places every spec into exactly one category (no loss, no duplication)', () => {
    const cats = buildCategories(CONFIG_KEY_SPECS);
    const total = cats.reduce((n, c) => n + c.keys.length, 0);
    expect(total).toBe(CONFIG_KEY_SPECS.length);
  });

  it('emits categories in CATEGORY_ORDER and never empty', () => {
    const cats = buildCategories(CONFIG_KEY_SPECS);
    const order = cats.map((c) => CATEGORY_ORDER.indexOf(c.name));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    for (const c of cats) expect(c.keys.length).toBeGreaterThan(0);
  });
});

describe('formatValue', () => {
  it('renders unset / arrays / primitives cleanly', () => {
    expect(formatValue(undefined)).toBe('(unset)');
    expect(formatValue(true)).toBe('true');
    expect(formatValue(0.7)).toBe('0.7');
    expect(formatValue([1, 2, 3])).toBe('1,2,3');
    expect(formatValue([])).toBe('(empty)');
  });
});

describe('keyRowLabel', () => {
  it('prefixes a lock glyph on human-tier keys and none on agent-tier', () => {
    const [temp, perm] = TWO_KEY_SPECS;
    expect(keyRowLabel(temp!, 1.0, 14)).not.toContain('🔒');
    expect(keyRowLabel(perm!, 'plan', 14)).toContain('🔒');
    expect(keyRowLabel(temp!, 1.0, 14)).toContain('temperature');
    expect(keyRowLabel(temp!, 1.0, 14)).toContain('(number)');
  });
});

describe('editorFor', () => {
  it('booleans and enums become fixed-option pickers', () => {
    const boolSpec = getConfigKeySpec('bgSummaries')!;
    expect(editorFor(boolSpec)).toEqual({ kind: 'pick', options: ['true', 'false'] });

    const perm = getConfigKeySpec('permissionMode')!;
    const plan = editorFor(perm);
    expect(plan.kind).toBe('pick');
    if (plan.kind === 'pick') {
      expect(plan.options).toEqual(['default', 'plan', 'autonomous', 'bypassPermissions']);
    }
  });

  it('numbers become a text editor whose help shows the clamp range', () => {
    const temp = getConfigKeySpec('temperature')!;
    const plan = editorFor(temp);
    expect(plan.kind).toBe('text');
    if (plan.kind === 'text') expect(plan.help).toContain('[0..2]');
  });

  it('strings become a plain text editor', () => {
    const sys = getConfigKeySpec('systemPrompt')!;
    expect(editorFor(sys).kind).toBe('text');
  });
});

describe('makeValidator', () => {
  it('accepts valid values and rejects invalid ones (wraps coerceConfigValue)', () => {
    const temp = getConfigKeySpec('temperature')!;
    const vTemp = makeValidator(temp);
    expect(vTemp('1.5')).toBeNull();
    expect(vTemp('abc')).not.toBeNull();

    const perm = getConfigKeySpec('permissionMode')!;
    const vPerm = makeValidator(perm);
    expect(vPerm('plan')).toBeNull();
    expect(vPerm('nope')).not.toBeNull();
  });
});

// ── Orchestrator ─────────────────────────────────────────────────────────────

describe('runConfigMenu', () => {
  it('writes an agent-tier key via the text editor (no confirm) and echoes the restart note', async () => {
    // cat=Model&routing(0) → key=temperature(0) → text "1.5" → key esc → cat esc
    const ov = new FakeOverlays([0, 0, null, null], ['1.5']);
    const io = new FakeIo(TWO_KEY_SPECS, { temperature: 1.0 });

    await runConfigMenu(ov, io);

    expect(io.writes).toEqual([{ path: 'temperature', value: '1.5', human: false }]);
    expect(ov.emits.length).toBe(1);
    expect(ov.emits[0]).toContain('temperature');
    expect(ov.emits[0]).toContain('✓');
    expect(ov.emits[0]).toContain('restart');
    // The validator handed to the text overlay really rejects bad input.
    expect(ov.lastValidator).not.toBeNull();
    expect(ov.lastValidator!('abc')).not.toBeNull();
    expect(ov.lastValidator!('1.5')).toBeNull();
  });

  it('requires an explicit confirm before writing a human-tier key (Yes → write with allowHuman)', async () => {
    // cat=Advanced(1) → key=permissionMode(0) → enum pick "plan"(1) → confirm Yes(0) → key esc → cat esc
    const ov = new FakeOverlays([1, 0, 1, 0, null, null]);
    const io = new FakeIo(TWO_KEY_SPECS);

    await runConfigMenu(ov, io);

    expect(io.writes).toEqual([{ path: 'permissionMode', value: 'plan', human: true }]);
  });

  it('does not write a human-tier key when the confirm is declined', async () => {
    // ... confirm No(1) instead of Yes
    const ov = new FakeOverlays([1, 0, 1, 1, null, null]);
    const io = new FakeIo(TWO_KEY_SPECS);

    await runConfigMenu(ov, io);

    expect(io.writes).toEqual([]);
  });

  it('closes immediately with no writes when Esc is pressed at the top level', async () => {
    const ov = new FakeOverlays([null]);
    const io = new FakeIo(TWO_KEY_SPECS);

    await runConfigMenu(ov, io);

    expect(io.writes).toEqual([]);
    expect(ov.pickCalls.length).toBe(1);
  });

  it('surfaces a write failure without throwing and keeps the menu alive', async () => {
    const ov = new FakeOverlays([0, 0, null, null], ['1.5']);
    const io = new FakeIo(TWO_KEY_SPECS, { temperature: 1.0 });
    io.throwOn = 'temperature';

    await expect(runConfigMenu(ov, io)).resolves.toBeUndefined();

    expect(io.writes).toEqual([]);
    expect(ov.emits.length).toBe(1);
    expect(ov.emits[0]).toContain('✗');
    expect(ov.emits[0]).toContain('refused');
  });
});

// ── Provenance + live-apply wiring ───────────────────────────────────────────
//
// Contract: both MenuIo members are OPTIONAL. An io that omits them must render
// and write exactly as before — that back-compat is what keeps every fake above
// (and every non-TTY surface) valid.

describe('provenance + live-apply wiring', () => {
  const provIo = (
    values: Record<string, unknown>,
    prov: Partial<Record<string, ConfigProvenance>>,
    live?: LiveApplyOutcome,
  ): MenuIo & { writes: Array<{ path: string; value: string }>; liveCalls: string[] } => {
    const writes: Array<{ path: string; value: string }> = [];
    const liveCalls: string[] = [];
    return {
      writes,
      liveCalls,
      specs: () => TWO_KEY_SPECS,
      current: (p) => values[p],
      write: (p, v) => {
        writes.push({ path: p, value: v });
        return v;
      },
      provenance: (p) =>
        prov[p] ?? {
          path: p,
          effective: values[p],
          source: { kind: 'user', path: '/u/afk.config.json' },
          userValue: values[p],
        },
      applyLive: async (p, v) => {
        liveCalls.push(`${p}=${v}`);
        return live ?? { applied: false };
      },
    };
  };

  it('renders the EFFECTIVE value and names the shadowing tier in the row', async () => {
    // Enter the category (0), Esc out of the key list, Esc out of the menu.
    const ov = new FakeOverlays([0, null, null], []);
    const io = provIo(
      { temperature: 1.0 },
      {
        temperature: {
          path: 'temperature',
          effective: 0.2,
          source: { kind: 'env', via: 'AFK_TEMPERATURE' },
          shadowedBy: { kind: 'env', via: 'AFK_TEMPERATURE' },
          userValue: 1.0,
        },
      },
    );

    await runConfigMenu(ov, io);

    const rows = ov.pickCalls[1]!.options.join('\n');
    // The env value wins the display, NOT the 1.0 sitting in the file.
    expect(rows).toContain('0.2');
    expect(rows).not.toMatch(/temperature\s+1\b/);
    expect(rows).toContain('env AFK_TEMPERATURE');
  });

  it('warns before AND after a write that lands beneath a shadowing tier', async () => {
    const ov = new FakeOverlays([0, 0, null, null], ['1.5']);
    const io = provIo(
      { temperature: 1.0 },
      {
        temperature: {
          path: 'temperature',
          effective: 0.2,
          source: { kind: 'env', via: 'AFK_TEMPERATURE' },
          shadowedBy: { kind: 'env', via: 'AFK_TEMPERATURE' },
          userValue: 1.0,
        },
      },
    );

    await runConfigMenu(ov, io);

    expect(io.writes).toEqual([{ path: 'temperature', value: '1.5' }]);
    // Pre-write: the edit header carries the warning.
    const editHeader = ov.textCalls[0]!.header.join('\n');
    expect(editHeader).toContain('AFK_TEMPERATURE');
    // Post-write: success line, then the shadow warning.
    expect(ov.emits.some((e) => e.includes('✓'))).toBe(true);
    expect(ov.emits.some((e) => e.includes('AFK_TEMPERATURE'))).toBe(true);
  });

  it('reports a live-applied key instead of the restart note', async () => {
    const ov = new FakeOverlays([0, 0, null, null], ['1.5']);
    const io = provIo({ temperature: 1.0 }, {}, { applied: true, note: 'applied to this session' });

    await runConfigMenu(ov, io);

    expect(io.liveCalls).toEqual(['temperature=1.5']);
    const ok = ov.emits.find((e) => e.includes('✓'))!;
    expect(ok).toContain('applied to this session');
    expect(ok).not.toContain('restart');
  });

  it('keeps a saved-but-not-applied write reported as a SUCCESS plus a caveat', async () => {
    const ov = new FakeOverlays([0, 0, null, null], ['1.5']);
    const io = provIo({ temperature: 1.0 }, {}, { applied: false, reason: 'provider unreachable' });

    await runConfigMenu(ov, io);

    expect(io.writes).toHaveLength(1); // the write still counts
    expect(ov.emits.some((e) => e.includes('✓'))).toBe(true);
    expect(ov.emits.some((e) => e.includes('saved, but not applied live'))).toBe(true);
  });

  it('falls back to the pre-provenance rendering when io omits both members', async () => {
    const ov = new FakeOverlays([0, 0, null, null], ['1.5']);
    const io = new FakeIo(TWO_KEY_SPECS, { temperature: 1.0 });

    await runConfigMenu(ov, io);

    expect(io.writes).toEqual([{ path: 'temperature', value: '1.5', human: false }]);
    expect(ov.emits.find((e) => e.includes('✓'))).toContain('restart');
  });
});
