/**
 * Tests for TerminalCompositor — Tab + Enter dropdown selection.
 *
 * Split verbatim from the terminal-compositor.test.ts monolith (#369).
 * Shared mock factories live in ./terminal-compositor.test-helpers.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TerminalCompositor } from './terminal-compositor.js';
import { createAutocompleteState } from './input/autocomplete-state.js';
import { register as registerSlashCommand, resetRegistry as resetSlashRegistry } from './slash/registry.js';
import { __resetStdinClaimForTests } from './input/stdin-claim.js';
import { makeMockStdout, makeMockStdin, collectWrites } from './terminal-compositor.test-helpers.js';
import type { MockStdout, MockStdin } from './terminal-compositor.test-helpers.js';

beforeEach(() => {
  __resetStdinClaimForTests();
});

describe('TerminalCompositor — Tab applies dropdown selection', () => {
  let stdout: MockStdout;
  let stdin: MockStdin;

  beforeEach(() => {
    stdout = makeMockStdout();
    stdin = makeMockStdin();
    resetSlashRegistry();
    registerSlashCommand({
      name: '/mint',
      summary: 'stub for tab-apply coverage',
      handler: async () => ({ kind: 'noop' as const }),
    });
    registerSlashCommand({
      name: '/diagnose',
      summary: 'second stub',
      handler: async () => ({ kind: 'noop' as const }),
    });
  });

  afterEach(() => {
    resetSlashRegistry();
  });

  it('Tab on an open slash dropdown applies the selected candidate', async () => {
    const ac = createAutocompleteState();
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), autocompleteState: ac });
    await c.arm();

    // Type '/' to open the dropdown.
    stdin.emit('keypress', '/', { name: '/', sequence: '/' });
    expect(ac.dropdownOpen).toBe(true);
    expect(ac.candidates.length).toBeGreaterThan(0);

    // Capture the selected candidate's value (selectedIndex starts at 0).
    const selected = ac.candidates[ac.selectedIndex];
    expect(selected).toBeDefined();
    const expectedValue = selected!.value;

    // Tab — applies selection.
    stdin.emit('keypress', undefined, { name: 'tab' });

    // Buffer should be the selected slash command + trailing space.
    expect(c.getBuffer().text).toBe(expectedValue + ' ');
    // Dropdown should be closed after applying.
    expect(ac.dropdownOpen).toBe(false);
  });

  it('Tab with no dropdown open is a no-op (does not insert literal tab)', async () => {
    const ac = createAutocompleteState();
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), autocompleteState: ac });
    await c.arm();

    // Type a non-trigger character — no dropdown.
    stdin.emit('keypress', 'a', { name: 'a', sequence: 'a' });
    expect(ac.dropdownOpen).toBe(false);
    const beforeTab = c.getBuffer().text;

    stdin.emit('keypress', undefined, { name: 'tab' });

    // Buffer unchanged — Tab was swallowed.
    expect(c.getBuffer().text).toBe(beforeTab);
  });

  it('Shift+Tab does NOT apply selection (preserves any future onShiftTab semantics)', async () => {
    const ac = createAutocompleteState();
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), autocompleteState: ac });
    await c.arm();

    stdin.emit('keypress', '/', { name: '/', sequence: '/' });
    expect(ac.dropdownOpen).toBe(true);
    const bufferBefore = c.getBuffer().text;

    // Shift+Tab — must NOT apply selection (reader.ts uses shift-tab for thinking-mode toggle).
    stdin.emit('keypress', undefined, { name: 'tab', shift: true });

    // Buffer unchanged; dropdown still open.
    expect(c.getBuffer().text).toBe(bufferBefore);
    expect(ac.dropdownOpen).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Enter applies dropdown selection (regression: hitting Enter on an open
// slash-command dropdown must finalize the highlighted candidate AND fire
// onSubmit, not submit the raw partial. Mirrors reader.ts:734-748. The
// compositor became the exclusive TTY Enter path in Stage 3e (commit
// 4e28e5d) but the dropdown-Enter guard was never ported — this suite
// guards against re-introducing that gap.
// ---------------------------------------------------------------------------

describe('TerminalCompositor — Enter applies dropdown selection', () => {
  let stdout: MockStdout;
  let stdin: MockStdin;

  beforeEach(() => {
    stdout = makeMockStdout();
    stdin = makeMockStdin();
    resetSlashRegistry();
    registerSlashCommand({
      name: '/mint',
      summary: 'stub for enter-apply coverage',
      handler: async () => ({ kind: 'noop' as const }),
    });
    registerSlashCommand({
      name: '/diagnose',
      summary: 'second stub so /mi is unambiguous',
      handler: async () => ({ kind: 'noop' as const }),
    });
  });

  afterEach(() => {
    resetSlashRegistry();
  });

  it('Enter on an open slash dropdown applies selection AND fires onSubmit with completed text', async () => {
    const onSubmit = vi.fn();
    const ac = createAutocompleteState();
    const c = new TerminalCompositor({
      stdout,
      stdin,
      onCancel: vi.fn(),
      autocompleteState: ac,
      onSubmit,
    });
    await c.arm();
    c.setInputMode('idle');

    // Type '/mi' — narrows the dropdown to a single candidate (/mint).
    stdin.emit('keypress', '/', { name: '/', sequence: '/' });
    stdin.emit('keypress', 'm', { name: 'm', sequence: 'm' });
    stdin.emit('keypress', 'i', { name: 'i', sequence: 'i' });
    expect(ac.dropdownOpen).toBe(true);
    const selected = ac.candidates[ac.selectedIndex];
    expect(selected).toBeDefined();
    const expectedValue = selected!.value;
    expect(expectedValue).toBe('/mint');

    // Enter — must apply the dropdown selection AND submit. Before the
    // fix this submitted '/mi' raw.
    stdin.emit('keypress', undefined, { name: 'return' });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ text: expectedValue + ' ', attachments: [] });
    // Dropdown must be closed after applying.
    expect(ac.dropdownOpen).toBe(false);
  });

  it('Enter on an open slash dropdown with NO matching candidate suppresses submit (does not send raw partial)', async () => {
    const onSubmit = vi.fn();
    const ac = createAutocompleteState();
    const c = new TerminalCompositor({
      stdout,
      stdin,
      onCancel: vi.fn(),
      autocompleteState: ac,
      onSubmit,
    });
    await c.arm();
    c.setInputMode('idle');

    // Open the dropdown with '/'.
    stdin.emit('keypress', '/', { name: '/', sequence: '/' });
    expect(ac.dropdownOpen).toBe(true);
    // Force the candidate list to empty WHILE dropdownOpen stays true —
    // exercises the "applySelection no-op" branch (kind === 'slash' &&
    // applied === false). Mirrors reader.ts COR-2.
    ac.candidates = [];
    ac.selectedIndex = 0;

    stdin.emit('keypress', undefined, { name: 'return' });

    // No submit fired — the raw '/' must NOT escape as a non-command.
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Enter on an open @file dropdown finalizes path but does NOT submit (user is mid-sentence)', async () => {
    const onSubmit = vi.fn();
    const ac = createAutocompleteState();
    const c = new TerminalCompositor({
      stdout,
      stdin,
      onCancel: vi.fn(),
      autocompleteState: ac,
      onSubmit,
    });
    await c.arm();
    c.setInputMode('idle');

    // Forge a file-trigger dropdown directly — the real file resolver is
    // out of scope here; we only care that `kind === 'file'` causes Enter
    // to apply-only without submitting. This is the file-completion arm
    // of reader.ts:734-748 (kind !== 'slash' branch).
    stdin.emit('keypress', '@', { name: '@', sequence: '@' });
    stdin.emit('keypress', 's', { name: 's', sequence: 's' });
    ac.dropdownOpen = true;
    ac.trigger = { kind: 'file', query: 's' };
    ac.candidates = [{ value: '@src/foo.ts', summary: '' }];
    ac.selectedIndex = 0;

    stdin.emit('keypress', undefined, { name: 'return' });

    // onSubmit must NOT have fired — Enter on a file completion only
    // accepts the path; the user is still composing the prompt body.
    expect(onSubmit).not.toHaveBeenCalled();
    // The path should have been applied to the buffer.
    expect(c.getBuffer().text).toContain('@src/foo.ts');
    // Dropdown closed.
    expect(ac.dropdownOpen).toBe(false);
  });

  it('Enter on an open --flag dropdown finalizes flag but does NOT submit', async () => {
    const onSubmit = vi.fn();
    const ac = createAutocompleteState();
    const c = new TerminalCompositor({
      stdout,
      stdin,
      onCancel: vi.fn(),
      autocompleteState: ac,
      onSubmit,
    });
    await c.arm();
    c.setInputMode('idle');

    // Forge a flag-trigger dropdown — same shape as file-trigger; the
    // guard's `kind !== 'slash'` branch covers both.
    stdin.emit('keypress', '/', { name: '/', sequence: '/' });
    stdin.emit('keypress', 'm', { name: 'm', sequence: 'm' });
    stdin.emit('keypress', 'i', { name: 'i', sequence: 'i' });
    stdin.emit('keypress', 'n', { name: 'n', sequence: 'n' });
    stdin.emit('keypress', 't', { name: 't', sequence: 't' });
    stdin.emit('keypress', ' ', { name: 'space', sequence: ' ' });
    stdin.emit('keypress', '-', { name: '-', sequence: '-' });
    stdin.emit('keypress', '-', { name: '-', sequence: '-' });
    ac.dropdownOpen = true;
    ac.trigger = { kind: 'flag', command: '/mint', query: '' };
    ac.candidates = [{ value: '--continue', summary: '' }];
    ac.selectedIndex = 0;

    stdin.emit('keypress', undefined, { name: 'return' });

    // Same contract as file-trigger: apply only, no submit.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(c.getBuffer().text).toContain('--continue');
    expect(ac.dropdownOpen).toBe(false);
  });

  it('Enter in streaming mode on an open slash dropdown applies selection before queueing', async () => {
    // Streaming mode (default) doesn't fire onSubmit on Enter — it sets
    // queued=true so the parent can pick the completed buffer up at
    // stream-end. The dropdown selection must still be applied first so
    // the queued buffer holds the completed command, not the raw partial.
    const ac = createAutocompleteState();
    const c = new TerminalCompositor({
      stdout,
      stdin,
      onCancel: vi.fn(),
      autocompleteState: ac,
    });
    await c.arm();
    // No setInputMode call — default is 'streaming'.

    stdin.emit('keypress', '/', { name: '/', sequence: '/' });
    stdin.emit('keypress', 'm', { name: 'm', sequence: 'm' });
    stdin.emit('keypress', 'i', { name: 'i', sequence: 'i' });
    expect(ac.dropdownOpen).toBe(true);

    stdin.emit('keypress', undefined, { name: 'return' });

    // Buffer cleared after commit (new FIFO contract); queue holds '/mint '.
    // Dropdown is closed. The completion happened BEFORE the commit, so the
    // payload in the FIFO is the resolved command, never the raw partial.
    expect(c.getBuffer()).toEqual({ text: '', queued: true });
    expect(ac.dropdownOpen).toBe(false);
    expect(c.getPendingCount()).toBe(1);
    // Drain to verify the queued payload is the completed command.
    const onSubmit = vi.fn();
    c.setOnSubmit(onSubmit);
    c.setInputMode('idle');
    expect(onSubmit).toHaveBeenCalledWith({ text: '/mint ', attachments: [] });
  });
});

