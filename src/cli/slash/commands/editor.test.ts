/**
 * Tests for the /editor slash command and its shared $EDITOR handoff engine.
 *
 * Patterned on transcript.test.ts — /editor mirrors /transcript's TTY handoff:
 * it spawns an external process with `stdio: 'inherit'`, so it MUST suspend the
 * compositor input surface AND pause Node's stdin before the spawn, and restore
 * both (raw mode + input claim + stdin) on exit — in a `finally`, so a spawn
 * throw or a nonzero editor exit never leaves the REPL half-suspended.
 *
 * Coverage (the handoff contract):
 *   (a) spawns the RESOLVED editor with the temp path, seeding the buffer text
 *   (b) buffer REPLACED from file content on exit 0 (cursor at end, no submit)
 *   (c) buffer PRESERVED on nonzero exit (+ notice)
 *   (d) suspend/resume ordering holds even when spawn THROWS (finally semantics)
 *   (e) trailing-newline strip (single \n only)
 *   (f) no $VISUAL/$EDITOR → helpful error, NO spawn
 * Plus VISUAL-over-EDITOR precedence, non-TTY refusal, temp-dir cleanup, and
 * the Ctrl+O keybinding dispatch (fires onOpenEditor exactly once).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { SlashContext } from '../types.js';

// Mock the child_process spawn + the fs read-back so no real editor launches
// and no real temp files are touched. mkdtemp/writeFile/readFile/rm are all
// stubbed; readFile returns the per-test "edited" content.
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

// `editedContent` is what the mocked readFile hands back per-test. The fs spies
// are plain closures (NOT vi.fn with a stored mockResolvedValue) so that the
// per-test `vi.clearAllMocks()` — which wipes vi.fn implementations — cannot
// blank out mkdtemp's resolved path and break the temp-file join.
let editedContent = '';
const rmSpy = vi.fn();
const writeFileSpy = vi.fn();
vi.mock('node:fs', () => ({
  promises: {
    mkdtemp: (): Promise<string> => Promise.resolve('/tmp/afk-editor-xxxx'),
    writeFile: (...args: unknown[]): Promise<void> => { writeFileSpy(...args); return Promise.resolve(); },
    readFile: (): Promise<string> => Promise.resolve(editedContent),
    rm: (...args: unknown[]): Promise<void> => { rmSpy(...args); return Promise.resolve(); },
  },
}));

import { spawn } from 'node:child_process';
import { openEditorForBuffer, resolveEditor } from './editor-open.ts';
import { editorCmd } from './editor.ts';

const mockSpawn = vi.mocked(spawn);

interface FakeCompositor {
  suspendInput: ReturnType<typeof vi.fn>;
  resumeInput: ReturnType<typeof vi.fn>;
  getBuffer: ReturnType<typeof vi.fn>;
  applyEdit: ReturnType<typeof vi.fn>;
}

function makeCompositor(bufferText = ''): FakeCompositor {
  return {
    suspendInput: vi.fn(),
    resumeInput: vi.fn(),
    getBuffer: vi.fn().mockReturnValue({ text: bufferText, queued: false }),
    applyEdit: vi.fn(),
  };
}

interface Notice { kind: string; message: string }

/** Poll until the (mocked) editor spawn has been invoked, flushing the awaited mkdtemp/writeFile. */
async function flushUntilSpawn(): Promise<void> {
  for (let i = 0; i < 200 && mockSpawn.mock.calls.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe('/editor — $EDITOR handoff', () => {
  let origIsTTY: boolean | undefined;
  let pauseSpy: ReturnType<typeof vi.spyOn>;
  let resumeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    editedContent = '';
    origIsTTY = process.stdout.isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = true;
    // Never actually pause/resume the test runner's stdin.
    pauseSpy = vi.spyOn(process.stdin, 'pause').mockReturnValue(process.stdin);
    resumeSpy = vi.spyOn(process.stdin, 'resume').mockReturnValue(process.stdin);
    vi.stubEnv('VISUAL', '');
    vi.stubEnv('EDITOR', 'nvim');
  });

  afterEach(() => {
    (process.stdout as { isTTY?: boolean }).isTTY = origIsTTY;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  // ── resolveEditor precedence ────────────────────────────────────────────
  describe('resolveEditor', () => {
    it('prefers $VISUAL over $EDITOR and splits args', () => {
      vi.stubEnv('VISUAL', 'code --wait');
      vi.stubEnv('EDITOR', 'vim');
      expect(resolveEditor()).toEqual({ cmd: 'code', args: ['--wait'] });
    });

    it('falls back to $EDITOR when $VISUAL is unset', () => {
      vi.stubEnv('VISUAL', '');
      vi.stubEnv('EDITOR', 'vim');
      expect(resolveEditor()).toEqual({ cmd: 'vim', args: [] });
    });

    it('treats an empty $VISUAL/$EDITOR as unset (returns null)', () => {
      vi.stubEnv('VISUAL', '');
      vi.stubEnv('EDITOR', '');
      expect(resolveEditor()).toBeNull();
    });

    it('treats a whitespace-only value as unset', () => {
      vi.stubEnv('VISUAL', '   ');
      vi.stubEnv('EDITOR', '');
      expect(resolveEditor()).toBeNull();
    });
  });

  // ── (a) spawns resolved editor with temp path, seeds buffer ────────────────
  it('(a) suspends input + pauses stdin, then spawns the resolved editor with the temp path seeded with the buffer', async () => {
    const compositor = makeCompositor('draft prompt text');
    const notices: Notice[] = [];
    const child = new EventEmitter();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const p = openEditorForBuffer({
      compositor: compositor as never,
      notify: (kind, message) => notices.push({ kind, message }),
    });
    await flushUntilSpawn();

    // Pre-spawn: buffer read, temp file seeded with it, input suspended, stdin paused.
    expect(compositor.getBuffer).toHaveBeenCalledOnce();
    expect(writeFileSpy).toHaveBeenCalledOnce();
    expect(writeFileSpy.mock.calls[0]![0]).toContain('prompt.md');
    expect(writeFileSpy.mock.calls[0]![1]).toBe('draft prompt text');
    expect(compositor.suspendInput).toHaveBeenCalledOnce();
    expect(pauseSpy).toHaveBeenCalledOnce();
    expect(compositor.resumeInput).not.toHaveBeenCalled();

    // Editor spawned inheriting the terminal, with the temp prompt.md as last arg.
    expect(mockSpawn).toHaveBeenCalledOnce();
    const call = mockSpawn.mock.calls[0]!;
    expect(call[0]).toBe('nvim');
    const args = call[1] as string[];
    const opts = call[2] as { stdio?: string };
    expect(opts.stdio).toBe('inherit');
    expect(args.at(-1)).toContain('prompt.md');

    child.emit('exit', 0);
    await expect(p).resolves.toBe('loaded');
    // Restored after exit.
    expect(resumeSpy).toHaveBeenCalledOnce();
    expect(compositor.resumeInput).toHaveBeenCalledOnce();
  });

  // ── (b) buffer replaced from file content on exit 0 ────────────────────────
  it('(b) loads the edited file content into the buffer on exit 0 (cursor at end, no auto-submit)', async () => {
    const compositor = makeCompositor('old');
    editedContent = 'the new composed prompt';
    const child = new EventEmitter();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const p = openEditorForBuffer({ compositor: compositor as never, notify: () => {} });
    await flushUntilSpawn();
    child.emit('exit', 0);
    const result = await p;

    expect(result).toBe('loaded');
    // applyEdit called with an InputCoreState whose buffer is the edited text
    // and cursor is at the end (InputCore.seed places cursor at text.length).
    expect(compositor.applyEdit).toHaveBeenCalledOnce();
    const state = compositor.applyEdit.mock.calls[0]![0] as { buffer: string; cursor: number };
    expect(state.buffer).toBe('the new composed prompt');
    expect(state.cursor).toBe('the new composed prompt'.length);
  });

  // ── (c) buffer preserved on nonzero exit ───────────────────────────────────
  it('(c) preserves the original buffer and warns on a nonzero editor exit', async () => {
    const compositor = makeCompositor('keep me');
    editedContent = 'this should be ignored';
    const notices: Notice[] = [];
    const child = new EventEmitter();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const p = openEditorForBuffer({
      compositor: compositor as never,
      notify: (kind, message) => notices.push({ kind, message }),
    });
    await flushUntilSpawn();
    child.emit('exit', 1);
    const result = await p;

    expect(result).toBe('kept');
    // Buffer untouched — applyEdit never called on a nonzero exit.
    expect(compositor.applyEdit).not.toHaveBeenCalled();
    expect(notices.some((n) => n.kind === 'warn' && /status 1/.test(n.message))).toBe(true);
    // Still restored + cleaned up.
    expect(compositor.resumeInput).toHaveBeenCalledOnce();
    expect(rmSpy).toHaveBeenCalledOnce();
  });

  // ── (d) suspend/resume ordering holds even when spawn throws ───────────────
  it('(d) restores input in finally even when spawn throws synchronously (preserves buffer)', async () => {
    const compositor = makeCompositor('survive the throw');
    const notices: Notice[] = [];
    mockSpawn.mockImplementation(() => { throw new Error('spawn EACCES'); });

    const result = await openEditorForBuffer({
      compositor: compositor as never,
      notify: (kind, message) => notices.push({ kind, message }),
    });

    expect(result).toBe('spawn-failed');
    // Ordering: suspend happened, then resume ran in finally (both once).
    expect(compositor.suspendInput).toHaveBeenCalledOnce();
    expect(pauseSpy).toHaveBeenCalledOnce();
    expect(compositor.resumeInput).toHaveBeenCalledOnce();
    expect(resumeSpy).toHaveBeenCalledOnce();
    // Buffer preserved, temp dir cleaned, user warned.
    expect(compositor.applyEdit).not.toHaveBeenCalled();
    expect(rmSpy).toHaveBeenCalledOnce();
    expect(notices.some((n) => n.kind === 'warn')).toBe(true);
  });

  it('(d2) restores input in finally when the child emits an error event', async () => {
    const compositor = makeCompositor('draft');
    const child = new EventEmitter();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const p = openEditorForBuffer({ compositor: compositor as never, notify: () => {} });
    await flushUntilSpawn();
    expect(compositor.suspendInput).toHaveBeenCalledOnce();

    child.emit('error', new Error('spawn nvim ENOENT'));
    const result = await p;

    expect(result).toBe('spawn-failed');
    expect(compositor.resumeInput).toHaveBeenCalledOnce();
    expect(resumeSpy).toHaveBeenCalledOnce();
    expect(compositor.applyEdit).not.toHaveBeenCalled();
  });

  // ── (e) trailing-newline strip ─────────────────────────────────────────────
  it('(e) strips exactly one trailing newline from the loaded content', async () => {
    const compositor = makeCompositor('');
    editedContent = 'line one\nline two\n';
    const child = new EventEmitter();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const p = openEditorForBuffer({ compositor: compositor as never, notify: () => {} });
    await flushUntilSpawn();
    child.emit('exit', 0);
    await p;

    const state = compositor.applyEdit.mock.calls[0]![0] as { buffer: string };
    // Exactly one trailing \n removed — the internal newline is preserved.
    expect(state.buffer).toBe('line one\nline two');
  });

  it('(e2) strips only ONE of multiple trailing newlines', async () => {
    const compositor = makeCompositor('');
    editedContent = 'body\n\n';
    const child = new EventEmitter();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const p = openEditorForBuffer({ compositor: compositor as never, notify: () => {} });
    await flushUntilSpawn();
    child.emit('exit', 0);
    await p;

    const state = compositor.applyEdit.mock.calls[0]![0] as { buffer: string };
    expect(state.buffer).toBe('body\n');
  });

  it('(e3) preserves multi-byte UTF-8 content read back verbatim', async () => {
    const compositor = makeCompositor('');
    editedContent = 'café — 日本語 🎉\n';
    const child = new EventEmitter();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const p = openEditorForBuffer({ compositor: compositor as never, notify: () => {} });
    await flushUntilSpawn();
    child.emit('exit', 0);
    await p;

    const state = compositor.applyEdit.mock.calls[0]![0] as { buffer: string };
    expect(state.buffer).toBe('café — 日本語 🎉');
  });

  // ── (f) no $VISUAL/$EDITOR → helpful error, no spawn ───────────────────────
  it('(f) prints a helpful error and does NOT spawn when neither $VISUAL nor $EDITOR is set', async () => {
    vi.stubEnv('VISUAL', '');
    vi.stubEnv('EDITOR', '');
    const compositor = makeCompositor('draft');
    const notices: Notice[] = [];

    const result = await openEditorForBuffer({
      compositor: compositor as never,
      notify: (kind, message) => notices.push({ kind, message }),
    });

    expect(result).toBe('no-editor');
    expect(mockSpawn).not.toHaveBeenCalled();
    // Never suspended — no handoff attempted.
    expect(compositor.suspendInput).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
    const err = notices.find((n) => n.kind === 'error');
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/VISUAL|EDITOR/);
  });

  // ── non-TTY refusal ────────────────────────────────────────────────────────
  it('refuses politely with no spawn when there is no compositor', async () => {
    const notices: Notice[] = [];
    const result = await openEditorForBuffer({
      compositor: null,
      notify: (kind, message) => notices.push({ kind, message }),
    });
    expect(result).toBe('no-tty');
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(notices.some((n) => n.kind === 'info')).toBe(true);
  });

  it('refuses politely when stdout is not a TTY (non-interactive surface)', async () => {
    (process.stdout as { isTTY?: boolean }).isTTY = false;
    const compositor = makeCompositor('draft');
    const notices: Notice[] = [];
    const result = await openEditorForBuffer({
      compositor: compositor as never,
      notify: (kind, message) => notices.push({ kind, message }),
    });
    expect(result).toBe('no-tty');
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(compositor.suspendInput).not.toHaveBeenCalled();
  });

  // ── slash-command integration ──────────────────────────────────────────────
  describe('editorCmd handler', () => {
    it('returns continue and routes through getCompositor', async () => {
      const compositor = makeCompositor('draft');
      editedContent = 'edited\n';
      const child = new EventEmitter();
      mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

      const lines: string[] = [];
      const ctx = {
        session: { current: {} },
        out: {
          line: (t = ''): void => { lines.push(`LINE:${t}`); },
          raw: (t: string): void => { lines.push(`RAW:${t}`); },
          success: (t: string): void => { lines.push(`SUCCESS:${t}`); },
          info: (t: string): void => { lines.push(`INFO:${t}`); },
          warn: (t: string): void => { lines.push(`WARN:${t}`); },
          error: (t: string): void => { lines.push(`ERROR:${t}`); },
        },
        ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
        getCompositor: () => compositor,
      } as unknown as SlashContext;

      const resultPromise = editorCmd.handler(ctx, '');
      await flushUntilSpawn();
      child.emit('exit', 0);
      const result = await resultPromise;

      expect(result).toBe('continue');
      expect(compositor.applyEdit).toHaveBeenCalledOnce();
    });

    it('routes the missing-editor error through ctx.out.error', async () => {
      vi.stubEnv('VISUAL', '');
      vi.stubEnv('EDITOR', '');
      const compositor = makeCompositor('draft');
      const lines: string[] = [];
      const ctx = {
        session: { current: {} },
        out: {
          line: (t = ''): void => { lines.push(`LINE:${t}`); },
          raw: (t: string): void => { lines.push(`RAW:${t}`); },
          success: (t: string): void => { lines.push(`SUCCESS:${t}`); },
          info: (t: string): void => { lines.push(`INFO:${t}`); },
          warn: (t: string): void => { lines.push(`WARN:${t}`); },
          error: (t: string): void => { lines.push(`ERROR:${t}`); },
        },
        ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
        getCompositor: () => compositor,
      } as unknown as SlashContext;

      const result = await editorCmd.handler(ctx, '');
      expect(result).toBe('continue');
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(lines.some((l) => l.startsWith('ERROR:'))).toBe(true);
    });

    it('has a canonical name, an alias, and is attachment-agnostic', () => {
      expect(editorCmd.name).toBe('/editor');
      expect(editorCmd.aliases).toContain('/edit');
      expect(editorCmd.summary.length).toBeGreaterThan(0);
    });
  });
});
