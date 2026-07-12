/**
 * Tests for the /config interactive settings menu (render/config-menu.ts).
 *
 * Pure helpers (categorisation, formatting, editor planning, validation) are
 * tested directly. The orchestrator is exercised against scripted fake overlays
 * + a recording io — no real compositor and no disk writes.
 */

import { describe, it, expect } from 'vitest';
import {
  CATEGORY_ORDER,
  categoryOf,
  buildCategories,
  formatValue,
  keyRowLabel,
  editorFor,
  makeValidator,
  runConfigMenu,
  type MenuOverlays,
  type MenuIo,
} from './config-menu.js';
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
