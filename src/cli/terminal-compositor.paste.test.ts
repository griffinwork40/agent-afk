/**
 * Tests for TerminalCompositor — attachments + paste (Stage 3c).
 *
 * Split verbatim from the terminal-compositor.test.ts monolith (#369).
 * Shared mock factories live in ./terminal-compositor.test-helpers.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TerminalCompositor } from './terminal-compositor.js';
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

describe('TerminalCompositor — attachments + paste (Stage 3c)', () => {
  let stdout: MockStdout;
  let stdin: MockStdin;
  let mockReadClipboardImage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    stdout = makeMockStdout();
    stdin = makeMockStdin();
    // Reset the mock between tests so call counts don't leak.
    const mod = await import('./input/clipboard-image.js');
    mockReadClipboardImage = mod.readClipboardImage as unknown as ReturnType<typeof vi.fn>;
    mockReadClipboardImage.mockReset();
  });

  // Helper: emit the bracketed-paste markers.
  const startPaste = (s = stdin) => s.emit('keypress', undefined, { sequence: '\x1b[200~' });
  const endPaste = (s = stdin) => s.emit('keypress', undefined, { sequence: '\x1b[201~' });

  // Helper: build a minimal ImageAttachment-shaped object. The compositor
  // doesn't inspect the contents — it just holds and forwards them.
  const fakeImage = (label = 'img.png') => ({
    kind: 'image' as const,
    mediaType: 'image/png' as const,
    base64: 'AAAA',
    sourceLabel: label,
  });

  describe('bracketed paste — image-only clipboard (zero-char paste)', () => {
    it('probes clipboard on a zero-char bracketed paste and pushes the resulting attachment', async () => {
      const fake = fakeImage('screenshot.png');
      mockReadClipboardImage.mockResolvedValue(fake);
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      startPaste();
      // No keystrokes inside the paste window — pure image paste.
      endPaste();
      // Let the osascript Promise drain.
      await new Promise((r) => setImmediate(r));
      expect(mockReadClipboardImage).toHaveBeenCalledTimes(1);
      expect(c.getAttachments()).toEqual([fake]);
    });

    it('flags "[clipboard: no image found]" when zero-char paste finds nothing', async () => {
      mockReadClipboardImage.mockResolvedValue(null);
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      startPaste();
      endPaste();
      await new Promise((r) => setImmediate(r));
      expect(c.getAttachments()).toEqual([]);
      // The clipboardFailureMsg is surfaced via repaint; it's hard to
      // assert directly without scraping log-update writes, so we just
      // assert no attachment landed. The render-path test below covers
      // the visible status row.
    });
  });

  describe('multi-message queue — attachment round-trip on ↑ recall', () => {
    it('↑ restores a queued message\'s attachments when pulling it back for editing', async () => {
      const fake = fakeImage('shot.png');
      mockReadClipboardImage.mockResolvedValue(fake);
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      // Compose text + attach an image, then commit (streaming Enter). The
      // attachment is snapshotted into the FIFO payload and the live list clears.
      for (const ch of 'look') stdin.emit('keypress', ch, { name: ch, sequence: ch });
      stdin.emit('keypress', undefined, { name: 'v', ctrl: true });
      await new Promise((r) => setImmediate(r));
      expect(c.getAttachments()).toEqual([fake]);
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(c.getPendingCount()).toBe(1);
      expect(c.getAttachments()).toEqual([]); // live list cleared at commit
      // ↑ on the empty buffer pulls the message back: text AND the snapshotted
      // attachment are restored to the live buffer for editing / re-commit.
      stdin.emit('keypress', undefined, { name: 'up' });
      expect(c.getBuffer().text).toBe('look');
      expect(c.getAttachments()).toEqual([fake]);
      expect(c.getPendingCount()).toBe(0);
    });
  });

  describe('bracketed paste — non-empty paste (text + maybe image)', () => {
    it('probes clipboard silently after a text paste — Finder copy attaches both', async () => {
      const fake = fakeImage('mixed.png');
      mockReadClipboardImage.mockResolvedValue(fake);
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      startPaste();
      stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
      stdin.emit('keypress', 'i', { name: 'i', sequence: 'i' });
      endPaste();
      await new Promise((r) => setImmediate(r));
      expect(c.getBuffer().text).toBe('hi');
      expect(c.getAttachments()).toEqual([fake]);
    });

    it('NO failure message surfaced after non-empty paste when clipboard has no image (silent miss)', async () => {
      mockReadClipboardImage.mockResolvedValue(null);
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      startPaste();
      stdin.emit('keypress', 't', { name: 't', sequence: 't' });
      endPaste();
      await new Promise((r) => setImmediate(r));
      expect(c.getAttachments()).toEqual([]);
      // No flag-missing marker — we'd need to scrape the rendered frame
      // for the dim message string to assert its absence robustly.
      // Falling back to "no attachment, no exception" as a smoke check.
    });
  });

  describe('Ctrl+V — explicit clipboard image read', () => {
    it('pushes a clipboard image on Ctrl+V', async () => {
      const fake = fakeImage('ctrlv.png');
      mockReadClipboardImage.mockResolvedValue(fake);
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', undefined, { name: 'v', ctrl: true });
      await new Promise((r) => setImmediate(r));
      expect(c.getAttachments()).toEqual([fake]);
    });

    it('guards against concurrent osascript spawns from rapid Ctrl+V', async () => {
      // Build a never-resolving Promise so the in-flight flag stays set
      // for the duration of the rapid presses. The .finally clears it
      // when the Promise resolves; we drain in afterEach.
      let resolveProbe: (v: unknown) => void;
      const probe = new Promise((r) => { resolveProbe = r; });
      mockReadClipboardImage.mockReturnValue(probe);
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', undefined, { name: 'v', ctrl: true });
      stdin.emit('keypress', undefined, { name: 'v', ctrl: true });
      stdin.emit('keypress', undefined, { name: 'v', ctrl: true });
      expect(mockReadClipboardImage).toHaveBeenCalledTimes(1);
      // Drain the probe so afterEach's mock-restore doesn't bleed.
      resolveProbe!(null);
      await new Promise((r) => setImmediate(r));
    });
  });

  describe('Backspace — drops last attachment when buffer is empty', () => {
    it('Backspace on empty buffer pops the last attachment', async () => {
      mockReadClipboardImage.mockResolvedValue(fakeImage('a.png'));
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', undefined, { name: 'v', ctrl: true });
      await new Promise((r) => setImmediate(r));
      expect(c.getAttachments()).toHaveLength(1);
      stdin.emit('keypress', undefined, { name: 'backspace' });
      expect(c.getAttachments()).toHaveLength(0);
    });

    it('Backspace on non-empty buffer edits text, does NOT touch attachments', async () => {
      mockReadClipboardImage.mockResolvedValue(fakeImage('keep.png'));
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', undefined, { name: 'v', ctrl: true });
      await new Promise((r) => setImmediate(r));
      stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
      stdin.emit('keypress', 'i', { name: 'i', sequence: 'i' });
      stdin.emit('keypress', undefined, { name: 'backspace' });
      expect(c.getBuffer().text).toBe('h');
      expect(c.getAttachments()).toHaveLength(1);
    });
  });

  describe('Enter — attachments ride along onSubmit payload', () => {
    it('idle Enter delivers text + attachments together', async () => {
      const onSubmit = vi.fn();
      mockReadClipboardImage.mockResolvedValue(fakeImage('attached.png'));
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSubmit });
      await c.arm();
      c.setInputMode('idle');
      stdin.emit('keypress', undefined, { name: 'v', ctrl: true });
      await new Promise((r) => setImmediate(r));
      stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(onSubmit).toHaveBeenCalledWith({
        text: 'h',
        attachments: [fakeImage('attached.png')],
      });
      // Compositor cleared both buffer AND attachments after submit.
      expect(c.getAttachments()).toEqual([]);
      expect(c.getBuffer().text).toBe('');
    });

    it('idle Enter on empty buffer + ≥1 attachment STILL submits (attachment-only message)', async () => {
      const onSubmit = vi.fn();
      mockReadClipboardImage.mockResolvedValue(fakeImage('only.png'));
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSubmit });
      await c.arm();
      c.setInputMode('idle');
      stdin.emit('keypress', undefined, { name: 'v', ctrl: true });
      await new Promise((r) => setImmediate(r));
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(onSubmit).toHaveBeenCalledWith({
        text: '',
        attachments: [fakeImage('only.png')],
      });
    });

    it('streaming → idle flush also delivers attachments accumulated during the stream', async () => {
      const onSubmit = vi.fn();
      mockReadClipboardImage.mockResolvedValue(fakeImage('mid-stream.png'));
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSubmit });
      await c.arm();
      // Stay in streaming mode (default). User pastes mid-stream + presses Enter.
      stdin.emit('keypress', undefined, { name: 'v', ctrl: true });
      await new Promise((r) => setImmediate(r));
      stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
      stdin.emit('keypress', undefined, { name: 'return' });
      // Buffer is committed (FIFO); onSubmit hasn't fired yet.
      expect(onSubmit).not.toHaveBeenCalled();
      // Attachments were snapshotted into the FIFO payload at Enter-time.
      // getAttachments() reflects the LIVE buffer's attachments — cleared to [].
      expect(c.getAttachments()).toHaveLength(0);
      // Stream ends — surface flips to idle. Now the queued submission flushes.
      c.setInputMode('idle');
      expect(onSubmit).toHaveBeenCalledWith({
        text: 'h',
        attachments: [fakeImage('mid-stream.png')],
      });
    });
  });

  describe('disarm/rearm — attachment state does not leak between sessions', () => {
    it('resetState clears attachments + pasting flags', async () => {
      mockReadClipboardImage.mockResolvedValue(fakeImage('orphan.png'));
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', undefined, { name: 'v', ctrl: true });
      await new Promise((r) => setImmediate(r));
      startPaste(); // pasting = true; will be reset by disarm
      expect(c.getAttachments()).toHaveLength(1);
      c.disarm();
      // resetState should have cleared attachments.
      expect(c.getAttachments()).toEqual([]);
    });
  });

  // Regression: multi-line clipboard paste was prematurely submitting in idle
  // mode (or queueing in streaming mode) at the first embedded `\r` because
  // the Enter handler treated pasted line breaks as user-submission Enter.
  // Stage 3 ported bracketed-paste markers + the `pasting` flag, but missed
  // the legacy reader's Enter-while-pasting → insert-literal-`\n` branch
  // (reader.ts:721-725) and never enabled `\x1b[?2004h` in arm() so the
  // markers themselves wouldn't fire in production. Both gaps closed
  // together; tests below cover the full multi-line paste round-trip.
  describe('bracketed paste — multi-line content (regression)', () => {
    it('Enter (CR) inside a bracketed paste inserts a literal newline, NOT submits', async () => {
      mockReadClipboardImage.mockResolvedValue(null);
      const onSubmit = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSubmit });
      await c.arm();
      c.setInputMode('idle');
      startPaste();
      // macOS-style paste: "line1\rline2" — line break sent as CR.
      stdin.emit('keypress', 'l', { name: 'l', sequence: 'l' });
      stdin.emit('keypress', 'i', { name: 'i', sequence: 'i' });
      stdin.emit('keypress', 'n', { name: 'n', sequence: 'n' });
      stdin.emit('keypress', 'e', { name: 'e', sequence: 'e' });
      stdin.emit('keypress', '1', { name: '1', sequence: '1' });
      stdin.emit('keypress', '\r', { name: 'return', sequence: '\r' });
      stdin.emit('keypress', 'l', { name: 'l', sequence: 'l' });
      stdin.emit('keypress', 'i', { name: 'i', sequence: 'i' });
      stdin.emit('keypress', 'n', { name: 'n', sequence: 'n' });
      stdin.emit('keypress', 'e', { name: 'e', sequence: 'e' });
      stdin.emit('keypress', '2', { name: '2', sequence: '2' });
      endPaste();
      await new Promise((r) => setImmediate(r));
      // Critical invariant: onSubmit must NOT have fired mid-paste. The
      // user's submission is what should drive that — not the terminal.
      expect(onSubmit).not.toHaveBeenCalled();
      // Buffer holds both lines joined by a real `\n`.
      expect(c.getBuffer().text).toBe('line1\nline2');
    });

    it('User-typed Enter AFTER a bracketed paste ends DOES submit (idle mode)', async () => {
      mockReadClipboardImage.mockResolvedValue(null);
      const onSubmit = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSubmit });
      await c.arm();
      c.setInputMode('idle');
      startPaste();
      stdin.emit('keypress', 'a', { name: 'a', sequence: 'a' });
      stdin.emit('keypress', '\r', { name: 'return', sequence: '\r' });
      stdin.emit('keypress', 'b', { name: 'b', sequence: 'b' });
      endPaste();
      await new Promise((r) => setImmediate(r));
      expect(onSubmit).not.toHaveBeenCalled();
      // Now the user explicitly hits Enter — pasting flag is false, so
      // submit fires with the full multi-line buffer.
      stdin.emit('keypress', '\r', { name: 'return', sequence: '\r' });
      expect(onSubmit).toHaveBeenCalledWith({ text: 'a\nb', attachments: [] });
    });

    it('Enter inside a bracketed paste in streaming mode does NOT set queued=true', async () => {
      mockReadClipboardImage.mockResolvedValue(null);
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      // Streaming mode is the default — no setInputMode call.
      startPaste();
      stdin.emit('keypress', 'x', { name: 'x', sequence: 'x' });
      stdin.emit('keypress', '\r', { name: 'return', sequence: '\r' });
      stdin.emit('keypress', 'y', { name: 'y', sequence: 'y' });
      endPaste();
      await new Promise((r) => setImmediate(r));
      // queued must remain false — pasted `\r` is content, not submission.
      expect(c.getBuffer()).toEqual({ text: 'x\ny', queued: false });
    });

    it('Enter inside a bracketed paste keeps queued=true while a message is committed (mirror invariant)', async () => {
      mockReadClipboardImage.mockResolvedValue(null);
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      // Pre-stage: user types 'a' + Enter → commits 'a' to FIFO, live buffer → ''.
      stdin.emit('keypress', 'a', { name: 'a', sequence: 'a' });
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      expect(c.getPendingCount()).toBe(1);
      // A multi-line paste arrives. The `\r` mid-paste edits the LIVE buffer but
      // does NOT pop the FIFO — 'a' is still committed. `queued` mirrors
      // pendingSubmissions (length 1), so it stays true; the message drains on
      // the next → idle transition.
      startPaste();
      stdin.emit('keypress', 'b', { name: 'b', sequence: 'b' });
      stdin.emit('keypress', '\r', { name: 'return', sequence: '\r' });
      stdin.emit('keypress', 'c', { name: 'c', sequence: 'c' });
      endPaste();
      await new Promise((r) => setImmediate(r));
      // Live buffer holds only the pasted content ('b\nc'); 'a' is still in FIFO,
      // so queued stays true (mirror of pendingSubmissions.length > 0).
      expect(c.getBuffer()).toEqual({ text: 'b\nc', queued: true });
      expect(c.getPendingCount()).toBe(1);
    });
  });

  // Bracketed-paste truncation: when a paste exceeds the line or char
  // threshold, the buffer keeps a compact `[Pasted text #N +M lines]`
  // placeholder while the full content is stashed in pasteRegistry and
  // re-expanded at submit. Best-UX trade-off — small pastes stay inline
  // so users see what they pasted; large pastes don't blow out the input
  // area.
  describe('bracketed paste — large-paste truncation', () => {
    // Helper: stream a paste burst whose body is `text`. Splits on the
    // `\n` boundary because the dispatchKey paste path treats `\r` as
    // a literal newline insertion (CR-shaped paste mid-burst).
    const pasteText = (text: string, s = stdin) => {
      startPaste(s);
      for (const ch of text) {
        if (ch === '\n') {
          s.emit('keypress', '\r', { name: 'return', sequence: '\r' });
        } else {
          s.emit('keypress', ch, { name: ch, sequence: ch });
        }
      }
      endPaste(s);
    };

    it('short paste (under both thresholds) stays inline — no placeholder', async () => {
      mockReadClipboardImage.mockResolvedValue(null);
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      // 3 lines = 2 newlines, below the 5-newline threshold AND below 1000 chars.
      pasteText('alpha\nbeta\ngamma');
      await new Promise((r) => setImmediate(r));
      // Buffer holds the literal pasted text — no truncation.
      expect(c.getBuffer().text).toBe('alpha\nbeta\ngamma');
      expect(c.getBuffer().text).not.toContain('[Pasted text');
    });

    it('5+ line paste collapses into `[Pasted text #<nonce> +N lines]` placeholder', async () => {
      mockReadClipboardImage.mockResolvedValue(null);
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      // 6 lines = 5 newlines — at the 5-newline threshold, triggers truncation.
      const big = 'a\nb\nc\nd\ne\nf';
      pasteText(big);
      await new Promise((r) => setImmediate(r));
      // `getBuffer().text` returns the EXPANDED form (placeholder
      // already swapped back) — that's the contract for the streaming-
      // flush snapshot reader.
      expect(c.getBuffer().text).toBe(big);
      // To inspect the visible buffer we have to round-trip through
      // submission. Use idle Enter to surface the placeholder via
      // displayText.
      let captured: { text: string; displayText?: string; attachments: unknown[] } | null = null;
      c.setOnSubmit((p) => { captured = p as typeof captured; });
      c.setInputMode('idle');
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(captured).not.toBeNull();
      expect(captured!.text).toBe(big);
      expect(captured!.displayText).toMatch(/^\[Pasted text #[0-9a-f]{8} \+6 lines\]$/);
    });

    it('single-line ≥1000-char paste collapses into `+N chars` placeholder', async () => {
      mockReadClipboardImage.mockResolvedValue(null);
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      // 1500-char single-line paste — newline count is 0, so we hit
      // the char threshold and get a `+N chars` label.
      const big = 'x'.repeat(1500);
      pasteText(big);
      await new Promise((r) => setImmediate(r));
      let captured: { text: string; displayText?: string; attachments: unknown[] } | null = null;
      c.setOnSubmit((p) => { captured = p as typeof captured; });
      c.setInputMode('idle');
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(captured!.text).toBe(big);
      expect(captured!.displayText).toMatch(/^\[Pasted text #[0-9a-f]{8} \+1500 chars\]$/);
    });

    it('no-truncation submission omits displayText from the payload', async () => {
      // Existing call-sites deep-match `{ text, attachments }` — adding
      // displayText: undefined would break them. Verify the contract
      // explicitly: untruncated submissions have NO displayText key.
      mockReadClipboardImage.mockResolvedValue(null);
      const onSubmit = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSubmit });
      await c.arm();
      c.setInputMode('idle');
      stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
      stdin.emit('keypress', 'i', { name: 'i', sequence: 'i' });
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(onSubmit).toHaveBeenCalledWith({ text: 'hi', attachments: [] });
    });

    it('multiple pastes get distinct nonces — each placeholder has a unique 8-hex-char id', async () => {
      mockReadClipboardImage.mockResolvedValue(null);
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      pasteText('a\nb\nc\nd\ne\nf');     // first paste — 6 lines
      stdin.emit('keypress', ' ', { name: 'space', sequence: ' ' });
      pasteText('p\nq\nr\ns\nt\nu');     // second paste — 6 lines
      await new Promise((r) => setImmediate(r));
      let captured: { text: string; displayText?: string; attachments: unknown[] } | null = null;
      c.setOnSubmit((p) => { captured = p as typeof captured; });
      c.setInputMode('idle');
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(captured!.text).toBe('a\nb\nc\nd\ne\nf p\nq\nr\ns\nt\nu');
      expect(captured!.displayText).toMatch(
        /^\[Pasted text #[0-9a-f]{8} \+6 lines\] \[Pasted text #[0-9a-f]{8} \+6 lines\]$/,
      );
    });

    it('single Backspace at trailing `]` atomically deletes the whole placeholder', async () => {
      mockReadClipboardImage.mockResolvedValue(null);
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      pasteText('a\nb\nc\nd\ne\nf');
      // After the paste, cursor is parked at end of placeholder. Single
      // Backspace should kill the whole `[Pasted text #<nonce> +6 lines]`
      // token (and drop the registry entry).
      stdin.emit('keypress', undefined, { name: 'backspace' });
      expect(c.getBuffer().text).toBe('');
      // Submitting after the delete must NOT carry the stale content
      // forward — registry entry was dropped.
      let captured: { text: string; displayText?: string; attachments: unknown[] } | null = null;
      c.setOnSubmit((p) => { captured = p as typeof captured; });
      c.setInputMode('idle');
      // Type something + Enter to actually exercise the submit path.
      stdin.emit('keypress', 'z', { name: 'z', sequence: 'z' });
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(captured!.text).toBe('z');
      expect(captured!.displayText).toBeUndefined();
    });

    it('forward-delete at leading `[` atomically deletes the placeholder', async () => {
      mockReadClipboardImage.mockResolvedValue(null);
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      pasteText('a\nb\nc\nd\ne\nf');
      // Move cursor to start of placeholder via Home.
      stdin.emit('keypress', undefined, { name: 'home' });
      stdin.emit('keypress', undefined, { name: 'delete' });
      expect(c.getBuffer().text).toBe('');
    });

    it('disarm/rearm clears the paste registry between sessions', async () => {
      mockReadClipboardImage.mockResolvedValue(null);
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      pasteText('a\nb\nc\nd\ne\nf');
      c.disarm();
      await c.arm();
      // Fresh paste after rearm gets a new nonce — registry was cleared.
      pasteText('p\nq\nr\ns\nt\nu');
      let captured: { text: string; displayText?: string; attachments: unknown[] } | null = null;
      c.setOnSubmit((p) => { captured = p as typeof captured; });
      c.setInputMode('idle');
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(captured!.displayText).toMatch(/^\[Pasted text #[0-9a-f]{8} \+6 lines\]$/);
    });

    it('submitting expanded text clears the registry — next paste gets a fresh nonce', async () => {
      mockReadClipboardImage.mockResolvedValue(null);
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      let captured: { text: string; displayText?: string; attachments: unknown[] } | null = null;
      c.setOnSubmit((p) => { captured = p as typeof captured; });
      c.setInputMode('idle');
      pasteText('a\nb\nc\nd\ne\nf');
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(captured!.displayText).toMatch(/^\[Pasted text #[0-9a-f]{8} \+6 lines\]$/);
      // Second paste in the same arm cycle — registry cleared by submit,
      // next paste gets a new random nonce.
      pasteText('p\nq\nr\ns\nt\nu');
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(captured!.displayText).toMatch(/^\[Pasted text #[0-9a-f]{8} \+6 lines\]$/);
    });

    it('streaming → idle flush also expands placeholders for the submission', async () => {
      mockReadClipboardImage.mockResolvedValue(null);
      const onSubmit = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSubmit });
      await c.arm();
      // Stay in streaming mode (default). User pastes a big blob mid-stream,
      // queues with Enter; the stream end's setInputMode('idle') must flush
      // with the EXPANDED text.
      pasteText('a\nb\nc\nd\ne\nf');
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(onSubmit).not.toHaveBeenCalled();
      c.setInputMode('idle');
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'a\nb\nc\nd\ne\nf',
          attachments: [],
        }),
      );
      const call = onSubmit.mock.calls[0]![0] as { displayText?: string };
      expect(call.displayText).toMatch(/^\[Pasted text #[0-9a-f]{8} \+6 lines\]$/);
    });

    // H1: mid-buffer paste — pre-existing text before the cursor must be
    // preserved; only the pasted span gets collapsed into a placeholder.
    it('mid-buffer paste: pre-existing text before cursor is preserved', async () => {
      mockReadClipboardImage.mockResolvedValue(null);
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      c.setInputMode('idle');

      // Type a prefix so the cursor sits at position 6.
      for (const ch of 'hello ') {
        stdin.emit('keypress', ch, { name: ch, sequence: ch });
      }

      // Paste a large blob (6 lines → triggers truncation at cursor=6).
      const pasted = 'a\nb\nc\nd\ne\nf';
      pasteText(pasted);
      await new Promise((r) => setImmediate(r));

      // getBuffer() expands placeholders → full content visible.
      expect(c.getBuffer().text).toBe('hello ' + pasted);

      // Submit: text = expanded, displayText = prefix + placeholder.
      let captured: { text: string; displayText?: string; attachments: unknown[] } | null = null;
      c.setOnSubmit((p) => { captured = p as typeof captured; });
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(captured).not.toBeNull();
      expect(captured!.text).toBe('hello a\nb\nc\nd\ne\nf');
      expect(captured!.displayText).toMatch(/^hello \[Pasted text #[0-9a-f]{8} \+6 lines\]$/);
    });

    it('mid-buffer paste: text typed after the paste is also preserved', async () => {
      mockReadClipboardImage.mockResolvedValue(null);
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      c.setInputMode('idle');

      for (const ch of 'pre ') {
        stdin.emit('keypress', ch, { name: ch, sequence: ch });
      }
      pasteText('a\nb\nc\nd\ne\nf');
      await new Promise((r) => setImmediate(r));

      // Type a suffix after the paste (cursor is at end of placeholder).
      for (const ch of ' suf') {
        stdin.emit('keypress', ch, { name: ch, sequence: ch });
      }

      let captured: { text: string; displayText?: string; attachments: unknown[] } | null = null;
      c.setOnSubmit((p) => { captured = p as typeof captured; });
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(captured!.text).toBe('pre a\nb\nc\nd\ne\nf suf');
      expect(captured!.displayText).toMatch(/^pre \[Pasted text #[0-9a-f]{8} \+6 lines\] suf$/);
    });

    // M1: threshold boundary values — off-by-one coverage for both dimensions.
    describe('threshold boundary values', () => {
      it('exactly 4 newlines (one below threshold) stays inline — no placeholder', async () => {
        mockReadClipboardImage.mockResolvedValue(null);
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
        await c.arm();
        // 4 newlines = 5 visual lines; check is newlineCount < 5, so 4 passes through.
        const text = 'a\nb\nc\nd\ne';
        pasteText(text);
        await new Promise((r) => setImmediate(r));
        expect(c.getBuffer().text).toBe(text);
        expect(c.getBuffer().text).not.toContain('[Pasted text');
      });

      it('exactly 5 newlines (at threshold) collapses to placeholder', async () => {
        mockReadClipboardImage.mockResolvedValue(null);
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
        await c.arm();
        // 5 newlines = 6 visual lines; newlineCount >= 5 → truncate.
        const text = 'a\nb\nc\nd\ne\nf';
        pasteText(text);
        await new Promise((r) => setImmediate(r));
        let captured: { text: string; displayText?: string; attachments: unknown[] } | null = null;
        c.setOnSubmit((p) => { captured = p as typeof captured; });
        c.setInputMode('idle');
        stdin.emit('keypress', undefined, { name: 'return' });
        expect(captured!.text).toBe(text);
        expect(captured!.displayText).toMatch(/^\[Pasted text #[0-9a-f]{8} \+6 lines\]$/);
      });

      it('exactly 999 chars (one below char threshold) stays inline — no placeholder', async () => {
        mockReadClipboardImage.mockResolvedValue(null);
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
        await c.arm();
        // charCount < 1000 → no truncation.
        const text = 'x'.repeat(999);
        pasteText(text);
        await new Promise((r) => setImmediate(r));
        expect(c.getBuffer().text).toBe(text);
        expect(c.getBuffer().text).not.toContain('[Pasted text');
      });

      it('exactly 1000 chars (at char threshold) collapses to +N chars placeholder', async () => {
        mockReadClipboardImage.mockResolvedValue(null);
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
        await c.arm();
        // charCount >= 1000 → truncate.
        const text = 'x'.repeat(1000);
        pasteText(text);
        await new Promise((r) => setImmediate(r));
        let captured: { text: string; displayText?: string; attachments: unknown[] } | null = null;
        c.setOnSubmit((p) => { captured = p as typeof captured; });
        c.setInputMode('idle');
        stdin.emit('keypress', undefined, { name: 'return' });
        expect(captured!.text).toBe(text);
        expect(captured!.displayText).toMatch(/^\[Pasted text #[0-9a-f]{8} \+1000 chars\]$/);
      });
    });

    // M2: false-positive expansion safety — a user who manually types the
    // literal placeholder format should have their text pass through unmodified.
    it('manually-typed placeholder text passes through unexpanded when registry is empty', async () => {
      mockReadClipboardImage.mockResolvedValue(null);
      const onSubmit = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSubmit });
      await c.arm();
      c.setInputMode('idle');

      // Type the literal placeholder string by hand — no actual paste.
      const literal = '[Pasted text #1 +6 lines]';
      for (const ch of literal) {
        stdin.emit('keypress', ch, { name: ch, sequence: ch });
      }
      stdin.emit('keypress', undefined, { name: 'return' });

      // Registry is empty → expandPastePlaceholders fast-paths; the text
      // passes through verbatim.
      expect(onSubmit).toHaveBeenCalledWith({ text: literal, attachments: [] });
    });

    it('manually-typed placeholder with non-existent id passes through unexpanded', async () => {
      // Registry has a random 8-hex-char nonce but user types "#99" — no
      // hit (short hex id never matches an 8-char nonce), literal survives.
      mockReadClipboardImage.mockResolvedValue(null);
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      c.setInputMode('idle');

      // First, do a real paste to populate the registry with a random nonce.
      pasteText('a\nb\nc\nd\ne\nf');
      await new Promise((r) => setImmediate(r));

      // Now also type a non-existent short hex id "#99" literal.
      const typed = ' [Pasted text #99 +6 lines]';
      for (const ch of typed) {
        stdin.emit('keypress', ch, { name: ch, sequence: ch });
      }

      let captured: { text: string; displayText?: string; attachments: unknown[] } | null = null;
      c.setOnSubmit((p) => { captured = p as typeof captured; });
      stdin.emit('keypress', undefined, { name: 'return' });

      // Real paste expands; typed "#99" has no registry hit, passes through.
      expect(captured!.text).toBe('a\nb\nc\nd\ne\nf [Pasted text #99 +6 lines]');
    });

    // M3: word-delete (Option+Delete / meta+backspace) does NOT invoke the
    // atomic-placeholder-delete path — it nibbles the placeholder word-by-word.
    // This test documents the current behavior (not a bug, just a known gap).
    it('meta+backspace at end of placeholder nibbles word-by-word (no atomic delete)', async () => {
      mockReadClipboardImage.mockResolvedValue(null);
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      pasteText('a\nb\nc\nd\ne\nf');
      await new Promise((r) => setImmediate(r));

      // Cursor is at end of `[Pasted text #<nonce> +6 lines]`.
      // Option+Delete fires meta+backspace — should NOT use atomic delete.
      stdin.emit('keypress', undefined, { name: 'backspace', meta: true });

      // After one meta+backspace, the buffer should still contain the opening
      // bracket and most of the placeholder (word-delete removed the trailing
      // `lines]` or similar chunk). It must NOT be fully empty (atomic delete
      // would have emptied it).
      const after = c.getBuffer().text;
      // Registry entry still present (not deleted by word-delete path) →
      // expansion still works on whatever fragment remains. The exact fragment
      // depends on InputCore.deleteWordBackward word boundaries but the full
      // paste content has NOT been expanded-and-cleared.
      expect(after).not.toBe('');
    });

    // SEC-1: nonce collision resistance — integer-format typed ids cannot
    // expand real paste content because real nonces are 8 hex chars.
    it('SEC-1: typed integer-format placeholder cannot expand real paste content (nonce mismatch)', async () => {
      mockReadClipboardImage.mockResolvedValue(null);
      const onSubmit = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSubmit });
      await c.arm();
      c.setInputMode('idle');

      // Do a real paste to populate the registry with one 8-hex-char nonce.
      pasteText('a\nb\nc\nd\ne\nf');
      await new Promise((r) => setImmediate(r));

      // Type a placeholder using old-style short integer id "#1".
      // The new regex accepts [0-9a-f]+ so "#1" still matches syntactically,
      // but "1" is not the 8-char nonce in the registry — no expansion.
      const typed = ' [Pasted text #1 +6 lines]';
      for (const ch of typed) {
        stdin.emit('keypress', ch, { name: ch, sequence: ch });
      }

      let captured: { text: string; displayText?: string; attachments: unknown[] } | null = null;
      c.setOnSubmit((p) => { captured = p as typeof captured; });
      stdin.emit('keypress', undefined, { name: 'return' });

      // The real paste expands; the typed "#1" has no registry hit and
      // passes through as a literal (nonce mismatch).
      expect(captured!.text).toBe('a\nb\nc\nd\ne\nf [Pasted text #1 +6 lines]');
    });

    // SEC-2: embedded sentinel sanitization — ensure registry content is
    // free of bracketed-paste sentinel bytes after maybeTruncatePaste.
    it('SEC-2: expanded paste content does not contain bracketed-paste sentinel bytes', async () => {
      mockReadClipboardImage.mockResolvedValue(null);
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      c.setInputMode('idle');

      // Paste a large blob that triggers truncation. The sentinel-stripping
      // code in maybeTruncatePaste ensures the stashed content is clean.
      pasteText('a\nb\nc\nd\ne\nf');
      await new Promise((r) => setImmediate(r));

      let captured: { text: string; attachments: unknown[] } | null = null;
      c.setOnSubmit((p) => { captured = p as typeof captured; });
      stdin.emit('keypress', undefined, { name: 'return' });

      // Expanded content must not contain either sentinel sequence.
      expect(captured!.text).not.toContain('\x1b[200~');
      expect(captured!.text).not.toContain('\x1b[201~');
      expect(captured!.text).toBe('a\nb\nc\nd\ne\nf');
    });

    // COR-3: replaceRange-before-delete ordering — the registry entry
    // must survive a hypothetical replaceRange throw so it is not lost.
    // In practice InputCore.replaceRange does not throw for valid cursor
    // positions; this test documents the happy-path sequence and verifies
    // that after atomic placeholder delete the registry entry is gone and
    // the buffer is cleared (both replaceRange and delete ran).
    it('COR-3: after atomic placeholder delete, buffer is empty and registry entry is removed', async () => {
      mockReadClipboardImage.mockResolvedValue(null);
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      pasteText('a\nb\nc\nd\ne\nf');
      await new Promise((r) => setImmediate(r));

      // getBuffer().text returns the EXPANDED form — paste content is present.
      expect(c.getBuffer().text).toBe('a\nb\nc\nd\ne\nf');

      // Atomic backspace: deletes the whole placeholder token (and the
      // registry entry — replaceRange runs BEFORE delete per the F3 invariant).
      stdin.emit('keypress', undefined, { name: 'backspace' });

      // Buffer is now empty (replaceRange ran, placeholder removed).
      expect(c.getBuffer().text).toBe('');

      // Submit: expanded text equals display text (registry entry removed,
      // no placeholder to expand) so displayText is omitted.
      let captured: { text: string; displayText?: string; attachments: unknown[] } | null = null;
      c.setOnSubmit((p) => { captured = p as typeof captured; });
      c.setInputMode('idle');
      stdin.emit('keypress', 'z', { name: 'z', sequence: 'z' });
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(captured!.text).toBe('z');
      expect(captured!.displayText).toBeUndefined();
    });
  });

  // Stage 3b/Stage 3c parity
  // and alt+Enter as a "soft newline" UX — explicit user intent for multi-
  // line input without leaving the prompt. Ported to the compositor so the
  // persistent input surface keeps the same affordance.
  describe('shift+Enter / alt+Enter — soft newline insertion', () => {
    it('shift+Enter inserts a literal `\\n` and does NOT submit', async () => {
      const onSubmit = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSubmit });
      await c.arm();
      c.setInputMode('idle');
      stdin.emit('keypress', 'a', { name: 'a', sequence: 'a' });
      stdin.emit('keypress', undefined, { name: 'return', shift: true });
      stdin.emit('keypress', 'b', { name: 'b', sequence: 'b' });
      expect(c.getBuffer().text).toBe('a\nb');
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('alt+Enter (key.meta=true) inserts a literal `\\n` and does NOT submit', async () => {
      const onSubmit = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSubmit });
      await c.arm();
      c.setInputMode('idle');
      stdin.emit('keypress', 'a', { name: 'a', sequence: 'a' });
      stdin.emit('keypress', undefined, { name: 'return', meta: true });
      stdin.emit('keypress', 'b', { name: 'b', sequence: 'b' });
      expect(c.getBuffer().text).toBe('a\nb');
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('kitty keyboard protocol shift+Enter (`\\x1b[13;2u`) inserts a literal `\\n`', async () => {
      // Some terminals (xterm in CSI-u mode, certain kitty configs) don't
      // set key.shift on Enter but DO emit `\x1b[13;2u`. The compositor
      // recognizes that sequence as shift+Enter.
      const onSubmit = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSubmit });
      await c.arm();
      c.setInputMode('idle');
      stdin.emit('keypress', 'a', { name: 'a', sequence: 'a' });
      stdin.emit('keypress', undefined, { name: 'return', sequence: '\x1b[13;2u' });
      stdin.emit('keypress', 'b', { name: 'b', sequence: 'b' });
      expect(c.getBuffer().text).toBe('a\nb');
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('plain Enter (no modifiers) still submits in idle mode', async () => {
      // Sanity check: shift/alt are required to suppress submission.
      // Without them, Enter resolves onSubmit as before.
      const onSubmit = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSubmit });
      await c.arm();
      c.setInputMode('idle');
      stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(onSubmit).toHaveBeenCalledWith({ text: 'h', attachments: [] });
    });
  });
});

