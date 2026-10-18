/**
 * AFK_CENTER_CONTENT live-frame margin guard.
 *
 * Invariant: in centered mode every non-blank row the compositor paints in
 * its live frame (spinner, tip/hint, attachment / clipboard / mode-notice,
 * dropdown, hint, input, picker rows) starts with EXACTLY the content margin
 * (never column 0, never a doubled margin) and fits the terminal without
 * autowrapping. The compositor's stdout width is the only width source — the
 * mock stdout is 200 cols while `process.stdout.columns` is left untouched,
 * so a surface that still reads `process.stdout` for its margin fails here.
 *
 * Rendered through @xterm/headless so the assertions are about what a
 * terminal actually shows, not about intermediate strings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { TerminalCompositor } from './terminal-compositor.js';
import { __resetStdinClaimForTests } from './input/stdin-claim.js';
import { createAutocompleteState } from './input/autocomplete-state.js';
import { register as registerSlashCommand, resetRegistry as resetSlashRegistry } from './slash/registry.js';
import { renderPickerRows, type PickerState } from './render/picker.js';
import { runTextInput } from './render/text-input.js';
import { makeMockStdin, makeMockStdout, collectWrites } from './terminal-compositor.test-helpers.js';

const COLS = 200;
const ROWS = 30;
const MARGIN = 50; // floor((200 - 100) / 2) with AFK_TEXT_MEASURE=100

interface ScreenRow { text: string; wrapped: boolean }

async function paintToScreen(data: string, cols: number): Promise<ScreenRow[]> {
  const term = new HeadlessTerminal({ cols, rows: ROWS, scrollback: 200, allowProposedApi: true, convertEol: true });
  await new Promise<void>((r) => term.write(data, r));
  const buf = term.buffer.active;
  const out: ScreenRow[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (line) out.push({ text: line.translateToString(true), wrapped: line.isWrapped });
  }
  term.dispose();
  return out;
}

function leadingSpaces(s: string): number {
  return s.length - s.trimStart().length;
}

async function scenario(
  centered: boolean,
  drive: (c: TerminalCompositor, stdin: ReturnType<typeof makeMockStdin>) => void,
): Promise<{ raw: string; rows: ScreenRow[] }> {
  __resetStdinClaimForTests();
  vi.stubEnv('AFK_CENTER_CONTENT', centered ? '1' : '');
  vi.stubEnv('AFK_TEXT_MEASURE', '100');
  const stdout = makeMockStdout();
  stdout.columns = COLS;
  stdout.rows = ROWS;
  const stdin = makeMockStdin();
  const writes = collectWrites(stdout);
  const ac = createAutocompleteState();
  const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), autocompleteState: ac, promptText: '> ' });
  await c.arm();
  c.setInputMode('idle');
  drive(c, stdin);
  const raw = writes.all();
  c.disarm();
  return { raw, rows: await paintToScreen(raw, COLS) };
}

function pickerRows(): string[] {
  const state: PickerState = { cursor: 0, scrollOffset: 0, filterQuery: '', filteredResults: [], selected: new Set() };
  return [...renderPickerRows(state, ['? PICKHEAD question'], ['PICKOPT_A', 'PICKOPT_B'], false, false, () => ROWS)];
}

const SCENARIOS: Record<string, { marks: string[]; drive: (c: TerminalCompositor, stdin: ReturnType<typeof makeMockStdin>) => void }> = {
  'spinner + wait hint (tip row)': {
    marks: ['...', 'Hint:'],
    drive: (c) => {
      c.setRootWaitActive(true);
      c.setSpinner({ enabled: true });
      c.repaint();
    },
  },
  'mode notice row': {
    marks: ['MODENOTICE_MARK'],
    drive: (c) => { c.setModeNotice('MODENOTICE_MARK plan mode on'); },
  },
  'clipboard failure row': {
    marks: ['CLIPFAIL_MARK'],
    drive: (c) => { c.clipboardFailureMsg = '[CLIPFAIL_MARK no image]'; c.repaint(); },
  },
  'dropdown + hint + input': {
    marks: ['margin-probe ', 'margin probe hint'],
    drive: (_c, stdin) => {
      stdin.emit('keypress', '/', { name: '/', sequence: '/' });
    },
  },
  'picker rows': {
    marks: ['PICKHEAD', 'PICKOPT_A', 'PICKOPT_B'],
    drive: (c) => {
      c.enterPickerMode({ renderRows: pickerRows, onKey: vi.fn() });
    },
  },
  // readTextOverlay (elicitation text/number input) is runTextInput on the
  // armed compositor's picker mode — NOT reader.repaint — so it shares the
  // picker-frame margin.
  'readTextOverlay (runTextInput) rows': {
    marks: ['TEXTHEAD', 'TEXTHELP'],
    drive: (c) => {
      void runTextInput(c, { header: ['? TEXTHEAD question'], help: 'TEXTHELP enter to submit' });
    },
  },
};

describe('live frame margin under AFK_CENTER_CONTENT (compositor owns the margin)', () => {
  beforeEach(() => {
    registerSlashCommand({
      name: 'margin-probe',
      summary: 'Probe candidate for the live-frame margin guard',
      hint: 'margin probe hint',
      handler: async () => 'continue' as const,
    });
  });
  afterEach(() => {
    resetSlashRegistry();
    vi.unstubAllEnvs();
  });

  for (const [name, { marks, drive }] of Object.entries(SCENARIOS)) {
    it(`${name}: every live row starts with exactly the margin and never wraps`, async () => {
      const { rows } = await scenario(true, drive);
      for (const mark of marks.filter((m) => m !== 'INPUT')) {
        const hits = rows.filter((r) => r.text.includes(mark));
        expect(hits.length, `"${mark}" must be painted`).toBeGreaterThan(0);
        for (const row of hits) {
          const lead = leadingSpaces(row.text);
          expect(lead, `"${mark}" row starts at col ${lead}: ${JSON.stringify(row.text.slice(0, 80))}`)
            .toBeGreaterThanOrEqual(MARGIN);
          expect(lead, `"${mark}" row is double-margined: ${JSON.stringify(row.text.slice(0, 120))}`)
            .toBeLessThan(2 * MARGIN);
        }
      }
      for (const row of rows) {
        if (row.text.trim() === '') continue;
        expect(row.wrapped, `row soft-wrapped: ${JSON.stringify(row.text.slice(0, 60))}`).toBe(false);
        expect(leadingSpaces(row.text), `row at col 0: ${JSON.stringify(row.text.slice(0, 60))}`)
          .toBeGreaterThanOrEqual(MARGIN);
      }
    });
  }

  it('picker rows land at the same column as the input prompt', async () => {
    const idle = await scenario(true, (c) => c.repaint());
    const prompt = idle.rows.find((r) => r.text.trimStart().startsWith('>'));
    expect(prompt).toBeDefined();
    const picker = await scenario(true, SCENARIOS['picker rows']!.drive);
    const head = picker.rows.find((r) => r.text.includes('PICKHEAD'));
    expect(leadingSpaces(head!.text)).toBe(leadingSpaces(prompt!.text));
  });

  it('centered picker: a label wider than the band does not wrap or land at col 0', async () => {
    // A label wider than the content band (100 cols) but within the terminal
    // (200 cols). withMargin (frame.lines.ts) prepends the margin without
    // truncation; the row fits because 120 + margin + prefix stays under the
    // 200-col terminal width, so no autowrap occurs. Band-width truncation
    // itself is deferred — see #3765.
    const wideLabel = 'W'.repeat(120); // 120 > band (100), < terminal (200)
    const { rows } = await scenario(true, (c) => {
      const state: PickerState = { cursor: 0, scrollOffset: 0, filterQuery: '', filteredResults: [], selected: new Set() };
      c.enterPickerMode({
        renderRows: () => [...renderPickerRows(state, ['? WIDE question'], [wideLabel], false, false, () => ROWS)],
        onKey: vi.fn(),
      });
    });
    const wideRow = rows.find((r) => r.text.includes('W'.repeat(10)));
    expect(wideRow, 'wide label row must be painted').toBeDefined();
    expect(wideRow!.wrapped, 'wide label row must not autowrap').toBe(false);
    expect(leadingSpaces(wideRow!.text), 'wide label row must start at margin').toBeGreaterThanOrEqual(MARGIN);
  });

  it('centering off: no live row gains a leading margin', async () => {
    for (const { marks, drive } of Object.values(SCENARIOS)) {
      const { rows } = await scenario(false, drive);
      for (const mark of marks.filter((m) => m !== 'INPUT' && m !== '...')) {
        for (const row of rows.filter((r) => r.text.includes(mark))) {
          expect(leadingSpaces(row.text)).toBeLessThan(MARGIN);
        }
      }
    }
  });
});
