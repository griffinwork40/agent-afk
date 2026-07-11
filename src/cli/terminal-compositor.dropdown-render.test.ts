/**
 * Tests for TerminalCompositor — renderDropdownRows + formatInputBuffer.
 *
 * Split verbatim from the terminal-compositor.test.ts monolith (#369).
 * Shared mock factories live in ./terminal-compositor.test-helpers.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TerminalCompositor } from './terminal-compositor.js';
import { CupFrameRenderer } from './cup-frame-renderer.js';
import { createAutocompleteState } from './input/autocomplete-state.js';
import { register as registerSlashCommand, resetRegistry as resetSlashRegistry } from './slash/registry.js';
import { __resetStdinClaimForTests } from './input/stdin-claim.js';
import { makeMockStdout, makeMockStdin, collectWrites } from './terminal-compositor.test-helpers.js';
import type { MockStdout, MockStdin } from './terminal-compositor.test-helpers.js';

// Mock readClipboardImage so the bracketed-paste / Ctrl+V branches can be
// exercised deterministically without spawning osascript.
vi.mock('./input/clipboard-image.js', () => ({
  readClipboardImage: vi.fn(),
}));

beforeEach(() => {
  __resetStdinClaimForTests();
});

describe('TerminalCompositor — renderDropdownRows() output', () => {
  let stdout: MockStdout;
  let stdin: MockStdin;
  let writes: ReturnType<typeof collectWrites>;

  beforeEach(() => {
    stdout = makeMockStdout();
    stdin = makeMockStdin();
    writes = collectWrites(stdout);
    // Seed the slash registry so filterSlashCandidates returns a real candidate
    // when the buffer contains '/'. Isolated per-test via afterEach cleanup.
    resetSlashRegistry();
    registerSlashCommand({
      name: '/render-test',
      summary: 'Stub for renderDropdownRows coverage',
      handler: async () => ({ kind: 'noop' as const }),
    });
  });

  afterEach(() => {
    resetSlashRegistry();
  });

  it('candidate text appears in the stdout frame when dropdownOpen is true', async () => {
    const ac = createAutocompleteState();
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), autocompleteState: ac });
    await c.arm();

    writes.clear();

    // Type '/' to trigger slash autocomplete — updateAutocomplete() will call
    // filterSlashCandidates('') which finds '/render-test' and sets dropdownOpen = true.
    stdin.emit('keypress', '/', { name: '/', sequence: '/' });

    // Dropdown must be open (earned via keystroke, not mutation).
    expect(ac.dropdownOpen).toBe(true);

    // The rendered frame written to stdout must contain the candidate value.
    const frame = writes.all();
    expect(frame).toContain('/render-test');
  });

  it('paste recomputes autocomplete and closes a now-stale slash dropdown (PR #574 regression)', async () => {
    const ac = createAutocompleteState();
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), autocompleteState: ac });
    await c.arm();

    // readClipboardImage is module-mocked; resolve it so the post-paste
    // clipboard probe does not reject on an undefined return.
    const clip = await import('./input/clipboard-image.js');
    (clip.readClipboardImage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    // Open the slash dropdown by typing '/'.
    stdin.emit('keypress', '/', { name: '/', sequence: '/' });
    expect(ac.dropdownOpen).toBe(true);

    // Paste a 6-line blob (>= 5 newlines -> truncates to a placeholder). The
    // applyEdit guard skips updateAutocomplete during the paste burst and
    // maybeTruncatePaste mutates the buffer directly, so the paste-end path
    // MUST call updateAutocomplete or the dropdown renders stale. Regression
    // guard for the PR #574 stale-dropdown fix.
    stdin.emit('keypress', undefined, { sequence: '\x1b[200~' });
    for (const ch of 'a\nb\nc\nd\ne\nf') {
      if (ch === '\n') stdin.emit('keypress', '\r', { name: 'return', sequence: '\r' });
      else stdin.emit('keypress', ch, { name: ch, sequence: ch });
    }
    stdin.emit('keypress', undefined, { sequence: '\x1b[201~' });
    await new Promise((r) => setImmediate(r));

    // The buffer no longer holds a bare slash token at the cursor, so the
    // dropdown must have been recomputed and closed.
    expect(ac.dropdownOpen).toBe(false);
  });

  it('input line is rendered AFTER dropdown rows in the frame (input pinned at bottom)', async () => {
    // Invariant: the compositor frame's last line is always the input row,
    // so log-update + DECSTBM pin the input one row above the status line
    // regardless of dropdown / hint / overlay state. The dropdown grows
    // UPWARD from the input — opening it does not shove the input up.
    //
    // We verify by typing `/` to open the dropdown, then asserting the
    // dropdown candidate text appears in the captured frame BEFORE the
    // typed `/` character that lives on the input row. log-update writes
    // the joined frame top-to-bottom in one string, so byte order of the
    // first occurrence reflects vertical row order.
    const ac = createAutocompleteState();
    const c = new TerminalCompositor({
      stdout, stdin, onCancel: vi.fn(), autocompleteState: ac, promptText: '> ',
    });
    await c.arm();

    writes.clear();

    stdin.emit('keypress', '/', { name: '/', sequence: '/' });
    expect(ac.dropdownOpen).toBe(true);

    const frame = writes.all();
    // The dropdown's `/render-test` row precedes the input row's
    // prompt+slash by frame-build order. The input row is identifiable
    // by the prompt prefix `> ` immediately followed by the `/` the
    // user just typed.
    const candidateIdx = frame.lastIndexOf('/render-test');
    const inputRowIdx = frame.lastIndexOf('> ');
    expect(candidateIdx).toBeGreaterThanOrEqual(0);
    expect(inputRowIdx).toBeGreaterThanOrEqual(0);
    // Candidate must appear earlier in the joined frame string than the
    // input row marker — meaning the candidate is rendered ABOVE the
    // input visually. Before the fix the order was reversed.
    expect(candidateIdx).toBeLessThan(inputRowIdx);
  });

  it('hint tooltip (↳ <when-to-use>) renders between dropdown and input when selected candidate has a hint', async () => {
    // The hint row is the `formatHintRow` tooltip — a `↳ <hint>` line
    // shown for the currently-highlighted candidate. In the bottom-pinned
    // layout it sits BELOW the dropdown rows and DIRECTLY ABOVE the input,
    // so the tooltip for the selected candidate is adjacent to the
    // cursor — same visual relationship the legacy reader.ts achieved
    // when the dropdown lived below the input.
    resetSlashRegistry();
    registerSlashCommand({
      name: '/hinted-cmd',
      summary: 'one-line summary',
      hint: 'When you need the long-form when-to-use tooltip',
      handler: async () => ({ kind: 'noop' as const }),
    });

    const ac = createAutocompleteState();
    const c = new TerminalCompositor({
      stdout, stdin, onCancel: vi.fn(), autocompleteState: ac, promptText: '> ',
    });
    await c.arm();
    writes.clear();

    stdin.emit('keypress', '/', { name: '/', sequence: '/' });
    expect(ac.dropdownOpen).toBe(true);

    const frame = writes.all();
    // The `↳` glyph is the structural marker for the hint row (palette.dim
    // wraps it but the bare character survives ANSI). Locate the first
    // occurrence and check the relative positioning against the dropdown
    // row above and the input row below.
    const candidateIdx = frame.lastIndexOf('/hinted-cmd');
    const hintIdx = frame.indexOf('↳');
    const inputRowIdx = frame.lastIndexOf('> ');
    expect(candidateIdx).toBeGreaterThanOrEqual(0);
    expect(hintIdx).toBeGreaterThanOrEqual(0);
    expect(inputRowIdx).toBeGreaterThanOrEqual(0);
    // Frame order top-to-bottom: dropdown → hint → input.
    expect(candidateIdx).toBeLessThan(hintIdx);
    expect(hintIdx).toBeLessThan(inputRowIdx);
  });

  it('no `↳` glyph in the frame when the selected candidate has no hint (reserved slot only)', async () => {
    // The default `/render-test` registered in the suite's beforeEach has
    // no `hint` field — `formatHintRow` returns null. The frame still
    // reserves a blank row in that slot (so the dropdown above doesn't
    // shift when the user navigates onto a hinted candidate), but no
    // visible tooltip glyph should appear.
    const ac = createAutocompleteState();
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), autocompleteState: ac });
    await c.arm();
    writes.clear();

    stdin.emit('keypress', '/', { name: '/', sequence: '/' });
    expect(ac.dropdownOpen).toBe(true);

    expect(writes.all()).not.toContain('↳');
  });

  it('frame row count is stable when navigating between hinted and un-hinted candidates', async () => {
    // Regression for PR #478: a previous version of renderHintRow()
    // returned null when the selected candidate had no `hint`, so the
    // frame oscillated between N and N+1 rows as the user navigated ↑/↓
    // across a hinted ↔ un-hinted boundary. The input row is pinned at
    // `rows-1` via CupFrameRenderer, so the dropdown above it visibly
    // shifted up by one row each navigation step — perceived as "the
    // compositor jumping up and down" while scrolling the menu.
    //
    // Many real commands carry no hint (`/allow-dir`, `/bgsub`,
    // `/changelog`, `/keys`, `/stats`, `/worktree`, the `/bgsub:*`
    // variants), so this boundary crossing fires constantly in
    // practice. Fix: always reserve a hint-row slot when the dropdown
    // is open, even if it renders blank.
    //
    // We assert by spying on CupFrameRenderer.prototype.render and
    // capturing the exact frame string passed on each call. The first
    // argument is `frameLines.join('\n')`, so counting `\n` in that
    // string is the literal row-count proxy. (We can't count `\n` in
    // the captured stdout writes — the renderer emits CUP escapes
    // instead of bare `\n`, so a stdout-based newline count would
    // trivially pass with 0 === 0 and miss the regression entirely.)
    const renderSpy = vi.spyOn(CupFrameRenderer.prototype, 'render');

    resetSlashRegistry();
    registerSlashCommand({
      name: '/aaa-hinted',
      summary: 'first alphabetically, hinted',
      hint: 'When you want the hint to render',
      handler: async () => ({ kind: 'noop' as const }),
    });
    registerSlashCommand({
      name: '/zzz-unhinted',
      summary: 'second alphabetically, no hint',
      handler: async () => ({ kind: 'noop' as const }),
    });

    const ac = createAutocompleteState();
    const c = new TerminalCompositor({
      stdout, stdin, onCancel: vi.fn(), autocompleteState: ac, promptText: '> ',
    });
    await c.arm();

    // First repaint: open dropdown. selectedIndex = 0 → /aaa-hinted (has hint).
    renderSpy.mockClear();
    stdin.emit('keypress', '/', { name: '/', sequence: '/' });
    expect(ac.dropdownOpen).toBe(true);
    expect(ac.candidates[ac.selectedIndex]?.value).toBe('/aaa-hinted');
    // The keypress can trigger more than one repaint (buffer edit +
    // dropdown-open transition). The LAST render call carries the
    // final settled frame for this keystroke — that's the one whose
    // row count must match the post-navigation settled frame.
    const hintedCalls = renderSpy.mock.calls;
    expect(hintedCalls.length).toBeGreaterThan(0);
    const hintedFrameStr = String(hintedCalls[hintedCalls.length - 1]![0]);
    const rowsHinted = hintedFrameStr.split('\n').length;

    // Second repaint: advance to /zzz-unhinted (index 1, no hint). The
    // dropdown renders REVERSED (index 0 pinned at the bottom, growing
    // upward), so moving to a HIGHER index is ↑, not ↓ — see the geometry
    // Invariant in handleVerticalNav().
    renderSpy.mockClear();
    stdin.emit('keypress', '', { name: 'up', sequence: '\x1b[A' });
    expect(ac.candidates[ac.selectedIndex]?.value).toBe('/zzz-unhinted');
    const unhintedCalls = renderSpy.mock.calls;
    expect(unhintedCalls.length).toBeGreaterThan(0);
    const unhintedFrameStr = String(unhintedCalls[unhintedCalls.length - 1]![0]);
    const rowsUnhinted = unhintedFrameStr.split('\n').length;

    // Both frames must have the same row count — the un-hinted frame
    // reserves a blank slot where the hinted frame draws the `↳ …`
    // tooltip. Without the reservation, the un-hinted frame would be
    // exactly one row shorter and the compositor would visually jump.
    // Non-zero guard so a future regression that bypasses the render
    // path (and captures zero frames) can't trivially pass.
    expect(rowsHinted).toBeGreaterThan(1);
    expect(rowsUnhinted).toBe(rowsHinted);

    // Sanity: confirm exactly one of the two captured frames carries
    // the `↳` glyph (so the test is actually exercising the hint /
    // no-hint boundary, not a false-negative where neither frame has
    // a hint).
    expect(hintedFrameStr).toContain('↳');
    expect(unhintedFrameStr).not.toContain('↳');

    renderSpy.mockRestore();
  });

  it('selected dropdown candidate is rendered closest to the input (last among dropdown rows)', async () => {
    // Fish/zsh-style invariant: when the dropdown grows upward, the
    // candidate at viewportStart (the selected-by-default index 0)
    // appears at the BOTTOM of the dropdown block — adjacent to the
    // input row. Higher candidate indices ascend visually away from the
    // input. Verified by registering a second slash command (so the
    // dropdown has at least two visible rows) and asserting the
    // alphabetically-earlier `/aaa-stub` (index 0, selected) appears
    // AFTER the index-1 candidate in the frame's joined byte stream.
    registerSlashCommand({
      name: '/aaa-stub',
      summary: 'first by sort order',
      handler: async () => ({ kind: 'noop' as const }),
    });
    registerSlashCommand({
      name: '/zzz-stub',
      summary: 'last by sort order',
      handler: async () => ({ kind: 'noop' as const }),
    });

    const ac = createAutocompleteState();
    const c = new TerminalCompositor({
      stdout, stdin, onCancel: vi.fn(), autocompleteState: ac, promptText: '> ',
    });
    await c.arm();
    writes.clear();

    stdin.emit('keypress', '/', { name: '/', sequence: '/' });
    expect(ac.dropdownOpen).toBe(true);
    // selectedIndex starts at 0; candidates are alphabetized by filterSlashCandidates.
    expect(ac.candidates[ac.selectedIndex]?.value).toBe('/aaa-stub');

    const frame = writes.all();
    const zzzIdx = frame.lastIndexOf('/zzz-stub');
    const aaaIdx = frame.lastIndexOf('/aaa-stub');
    expect(zzzIdx).toBeGreaterThanOrEqual(0);
    expect(aaaIdx).toBeGreaterThanOrEqual(0);
    // /zzz-stub (index 1) is rendered ABOVE /aaa-stub (selected, index 0),
    // so it appears earlier in the joined frame string.
    expect(zzzIdx).toBeLessThan(aaaIdx);
  });

  it('no candidate text in stdout frame when dropdownOpen is false', async () => {
    const ac = createAutocompleteState();
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), autocompleteState: ac });
    await c.arm();

    writes.clear();

    // Type a non-trigger character — no dropdown.
    stdin.emit('keypress', 'a', { name: 'a', sequence: 'a' });

    expect(ac.dropdownOpen).toBe(false);
    expect(writes.all()).not.toContain('/render-test');
  });

  it('delete key resets history recall (mirrors reader.ts delete behaviour)', async () => {
    // Regression: compositor delete branch must call history.resetRecall()
    // so _draft/_index are not corrupted when the user presses Delete while
    // in history-recall mode inside the compositor.
    const { makeHistory } = await import('./input/autocomplete-state.test.js').catch(
      () => ({ makeHistory: null }),
    );
    // makeHistory is local to autocomplete-state.test.ts — define a minimal
    // inline version here to avoid cross-test coupling.
    const resetRecall = vi.fn();
    const history = {
      back: vi.fn(() => 'entry'),
      forward: vi.fn(() => null),
      resetRecall,
      get inRecall() { return false; },
    };

    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), history });
    await c.arm();

    // Pre-load buffer with text so delete has something to remove.
    stdin.emit('keypress', 'a', { name: 'a', sequence: 'a' });
    stdin.emit('keypress', 'b', { name: 'b', sequence: 'b' });
    // Move cursor to start so delete acts on the first char.
    stdin.emit('keypress', undefined, { name: 'home' });

    resetRecall.mockClear();

    // Delete forward — must call history.resetRecall().
    stdin.emit('keypress', undefined, { name: 'delete' });

    expect(resetRecall).toHaveBeenCalledTimes(1);
    // Buffer should now be 'b' (deleted 'a').
    expect(c.getBuffer().text).toBe('b');
  });
});

// ---------------------------------------------------------------------------
// formatInputBuffer callback (Fix A): the compositor passes pre-cursor /
// post-cursor segments through a caller-supplied formatter so colorization
// can be wired without coupling the compositor to the slash registry.
// ---------------------------------------------------------------------------

describe('TerminalCompositor — formatInputBuffer callback', () => {
  let stdout: MockStdout;
  let stdin: MockStdin;
  let writes: ReturnType<typeof collectWrites>;

  beforeEach(() => {
    stdout = makeMockStdout();
    stdin = makeMockStdin();
    writes = collectWrites(stdout);
  });

  it('invokes formatInputBuffer with pre-cursor and post-cursor segments separately', async () => {
    const calls: string[] = [];
    const formatInputBuffer = vi.fn((segment: string) => {
      calls.push(segment);
      return `[${segment}]`;
    });

    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), formatInputBuffer });
    await c.arm();

    // Type 'abc' (cursor=3, past end → cursorText=' ', rawBefore='abc', rawAfter='')
    stdin.emit('keypress', 'a', { name: 'a', sequence: 'a' });
    stdin.emit('keypress', 'b', { name: 'b', sequence: 'b' });
    stdin.emit('keypress', 'c', { name: 'c', sequence: 'c' });
    // Two left arrows → cursor=1 on 'b'. rawBefore='a', rawAfter='c'.
    // (Cursor text 'b' is rendered raw via inverse SGR — does NOT pass through
    // the formatter; that's covered by the dedicated test below.)
    stdin.emit('keypress', undefined, { name: 'left' });
    stdin.emit('keypress', undefined, { name: 'left' });

    // The formatter must have been called with both segment shapes by the
    // final render — 'a' as the pre-cursor segment and 'c' as the post-cursor
    // segment after the second left arrow.
    expect(calls).toContain('a');
    expect(calls).toContain('c');
    // Rendered frame must contain the formatter's bracket wrappers, proving
    // formatter output (not raw segments) is what reached the render path.
    expect(writes.all()).toContain('[a]');
    expect(writes.all()).toContain('[c]');
  });

  it('renders raw segments when formatInputBuffer is not provided (backward-compat)', async () => {
    // Sanity: pre-existing callers that did not pass a formatter must keep working.
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    await c.arm();
    writes.clear();
    stdin.emit('keypress', 'x', { name: 'x', sequence: 'x' });

    // No throw, frame includes the raw typed char.
    expect(writes.all()).toContain('x');
  });

  it('does NOT pass the cursor character through the formatter', async () => {
    // The inverse-video cursor block is rendered raw so chained ANSI codes
    // (inverse + colorizer SGRs) don't compose into a broken cell. Verify by
    // checking the cursor char never appears as a formatter argument.
    const seen: string[] = [];
    const formatInputBuffer = (segment: string) => {
      seen.push(segment);
      return segment;
    };
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), formatInputBuffer });
    await c.arm();
    stdin.emit('keypress', 'a', { name: 'a', sequence: 'a' });
    stdin.emit('keypress', 'b', { name: 'b', sequence: 'b' });
    stdin.emit('keypress', undefined, { name: 'left' });
    // Now buffer='ab', cursor=1 → cursorText='b', before='a', after=''
    // The formatter must have received 'a' and '' but never 'b' (the cursor char).
    const lastTwoCalls = seen.slice(-2);
    expect(lastTwoCalls).toEqual(['a', '']);
  });
});

// ---------------------------------------------------------------------------
// Caret rendering (Fix B): cursor block is painted on every render — including
// when the buffer is empty — so the user always sees where input lands.
// ---------------------------------------------------------------------------

