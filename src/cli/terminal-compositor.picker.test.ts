/**
 * Tests for TerminalCompositor — picker mode.
 *
 * Split verbatim from the terminal-compositor.test.ts monolith (#369).
 * Shared mock factories live in ./terminal-compositor.test-helpers.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TerminalCompositor } from './terminal-compositor.js';
import { createAutocompleteState } from './input/autocomplete-state.js';
import { register as registerSlashCommand, resetRegistry as resetSlashRegistry } from './slash/registry.js';
import { __resetStdinClaimForTests } from './input/stdin-claim.js';
import { makeMockStdout, makeMockStdin, collectWrites } from './terminal-compositor.test-helpers.js';
import type { MockStdout, MockStdin } from './terminal-compositor.test-helpers.js';

beforeEach(() => {
  __resetStdinClaimForTests();
});

describe('TerminalCompositor — picker mode', () => {
  let stdout: MockStdout;
  let stdin: MockStdin;

  beforeEach(() => {
    stdout = makeMockStdout();
    stdin = makeMockStdin();
  });

  it('enterPickerMode flips inputMode to picker and triggers a repaint', async () => {
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    await c.arm();
    const onKey = vi.fn();
    const renderRows = vi.fn(() => ['  ? question', '  ▸ alpha', '  ↑/↓ pick · enter']);
    c.enterPickerMode({ renderRows, onKey });
    // renderRows is called every repaint; enterPickerMode calls repaint
    // synchronously so renderRows fires at least once before any key.
    expect(renderRows).toHaveBeenCalled();
    c.exitPickerMode();
    c.disarm();
  });

  it('enterPickerMode throws if a picker is already active', async () => {
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    await c.arm();
    const ctrl = { renderRows: () => [], onKey: vi.fn() };
    c.enterPickerMode(ctrl);
    expect(() => c.enterPickerMode(ctrl)).toThrow(/already active/);
    c.exitPickerMode();
    c.disarm();
  });

  it('exitPickerMode is idempotent (no-op when no picker active)', async () => {
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    await c.arm();
    expect(() => c.exitPickerMode()).not.toThrow();
    c.exitPickerMode(); // again
    c.disarm();
  });

  it('all keystrokes route to picker controller while picker is active', async () => {
    const onSubmit = vi.fn();
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSubmit });
    await c.arm();
    c.setInputMode('idle');
    const onKey = vi.fn();
    c.enterPickerMode({ renderRows: () => ['row'], onKey });
    // Various keys that would normally have semantics in idle mode
    stdin.emit('keypress', undefined, { name: 'return' });   // would normally fire onSubmit
    stdin.emit('keypress', undefined, { name: 'up' });
    stdin.emit('keypress', undefined, { name: 'down' });
    stdin.emit('keypress', undefined, { name: 'escape' });
    stdin.emit('keypress', 'a', { name: 'a', sequence: 'a' });
    stdin.emit('keypress', ' ', { name: 'space', sequence: ' ' });
    expect(onKey).toHaveBeenCalledTimes(6);
    // None of those keys reached the non-picker handlers (onSubmit etc.)
    expect(onSubmit).not.toHaveBeenCalled();
    c.exitPickerMode();
    c.disarm();
  });

  it('Ctrl+C in picker mode routes to onKey (not onCancel)', async () => {
    const onCancel = vi.fn();
    const c = new TerminalCompositor({ stdout, stdin, onCancel });
    await c.arm();
    const onKey = vi.fn();
    c.enterPickerMode({ renderRows: () => [], onKey });
    stdin.emit('keypress', undefined, { name: 'c', ctrl: true });
    expect(onCancel).not.toHaveBeenCalled();
    expect(onKey).toHaveBeenCalledTimes(1);
    expect(onKey.mock.calls[0]?.[1]?.name).toBe('c');
    expect(onKey.mock.calls[0]?.[1]?.ctrl).toBe(true);
    c.exitPickerMode();
    c.disarm();
  });

  it('exitPickerMode restores previous input mode', async () => {
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    await c.arm();
    c.setInputMode('idle');
    expect(c.getInputMode()).toBe('idle');
    c.enterPickerMode({ renderRows: () => [], onKey: vi.fn() });
    expect(c.getInputMode()).toBe('picker');
    c.exitPickerMode();
    expect(c.getInputMode()).toBe('idle');
    c.disarm();
  });

  it('repaintPicker triggers a repaint when picker is active', async () => {
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    await c.arm();
    const renderRows = vi.fn(() => ['row']);
    c.enterPickerMode({ renderRows, onKey: vi.fn() });
    renderRows.mockClear();
    c.repaintPicker();
    expect(renderRows).toHaveBeenCalled();
    c.exitPickerMode();
    c.disarm();
  });

  it('repaintPicker is a no-op when no picker is active', async () => {
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    await c.arm();
    // No throw, no error — just silent return.
    expect(() => c.repaintPicker()).not.toThrow();
    c.disarm();
  });

  it('picker frame replaces input region (buffer text NOT rendered)', async () => {
    // Build a compositor, type some buffer text, then enter picker mode
    // and verify the buffer is hidden from the frame.
    const writes = collectWrites(stdout);
    const c = new TerminalCompositor({
      stdout, stdin, onCancel: vi.fn(),
      promptTextFn: () => '> ',
    });
    await c.arm();
    stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
    stdin.emit('keypress', 'i', { name: 'i', sequence: 'i' });
    expect(c.getBuffer().text).toBe('hi');
    writes.clear();
    c.enterPickerMode({
      renderRows: () => ['  ? PICKER_HEADER', '  ▸ option-1'],
      onKey: vi.fn(),
    });
    // The picker frame's render should now contain the picker rows but
    // NOT the user's typed buffer (the input region is rented to the picker).
    const frameOutput = writes.all();
    expect(frameOutput).toContain('PICKER_HEADER');
    expect(frameOutput).toContain('option-1');
    expect(frameOutput).not.toContain('> hi');
    c.exitPickerMode();
    c.disarm();
  });

  it('exit restores buffer rendering — original input survives picker turn', async () => {
    const writes = collectWrites(stdout);
    const c = new TerminalCompositor({
      stdout, stdin, onCancel: vi.fn(),
      promptTextFn: () => '> ',
    });
    await c.arm();
    stdin.emit('keypress', 'x', { name: 'x', sequence: 'x' });
    expect(c.getBuffer().text).toBe('x');
    c.enterPickerMode({ renderRows: () => ['picker'], onKey: vi.fn() });
    writes.clear();
    c.exitPickerMode();
    // Buffer must be intact AND repainted (the input row should reappear).
    expect(c.getBuffer().text).toBe('x');
    expect(writes.all()).toContain('x');
    c.disarm();
  });

  it('disarm during active picker clears picker state (defence-in-depth)', async () => {
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    await c.arm();
    c.enterPickerMode({ renderRows: () => ['row'], onKey: vi.fn() });
    expect(c.getInputMode()).toBe('picker');
    c.disarm();
    // After disarm, input mode and picker controller are reset.
    expect(c.getInputMode()).toBe('streaming');
    // Re-arm and verify no picker leaked.
    await c.arm();
    expect(c.getInputMode()).toBe('streaming');
    c.disarm();
  });

  it('autocomplete dropdown is reset on enterPickerMode (no bleed into picker frame)', async () => {
    // Install an autocomplete state with an open dropdown, then enter
    // picker mode. The dropdown rows must not appear in the picker frame.
    const ac = createAutocompleteState();
    const c = new TerminalCompositor({
      stdout, stdin, onCancel: vi.fn(),
      autocompleteState: ac,
    });
    await c.arm();
    // Drive a slash so the dropdown opens. Register a fake slash so there's
    // at least one candidate; otherwise the dropdown stays closed.
    resetSlashRegistry();
    registerSlashCommand({
      name: 'fakecmd',
      summary: 'test command',
      handler: () => ({ handled: true, result: null }),
    });
    stdin.emit('keypress', '/', { name: '/', sequence: '/' });
    expect(ac.dropdownOpen).toBe(true);
    c.enterPickerMode({ renderRows: () => ['  ? picker'], onKey: vi.fn() });
    expect(ac.dropdownOpen).toBe(false);
    c.exitPickerMode();
    c.disarm();
    resetSlashRegistry();
  });
});

