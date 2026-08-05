/**
 * Tests for the shared $EDITOR TTY handoff primitive.
 *
 * `editor.test.ts` covers the buffer-flavoured wrapper end-to-end; this file
 * pins the primitive's own contract, which two callers now depend on:
 *   (a) refusal paths (no compositor, no $VISUAL/$EDITOR) never spawn
 *   (b) exit 0 → `clean`; nonzero → `nonzero`; sync throw / 'error' → `spawn-failed`
 *   (c) the editor is spawned on the REAL path given, with `stdio: 'inherit'`
 *   (d) the restore-always invariant: every path that suspends resumes, even
 *       when spawn throws — a half-suspended REPL is unrecoverable
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import { spawnEditorOnPath, resolveEditor } from './editor-spawn.js';

const mockSpawn = vi.mocked(spawn);

function makeCompositor(): {
  suspendInput: ReturnType<typeof vi.fn>;
  resumeInput: ReturnType<typeof vi.fn>;
} {
  return { suspendInput: vi.fn(), resumeInput: vi.fn() };
}

interface Notice { kind: string; message: string }

function collector(): { notices: Notice[]; notify: (kind: string, message: string) => void } {
  const notices: Notice[] = [];
  return { notices, notify: (kind, message) => { notices.push({ kind, message }); } };
}

/** Resolve after the mocked spawn has been called, flushing microtasks. */
async function flushUntilSpawn(): Promise<void> {
  for (let i = 0; i < 200 && mockSpawn.mock.calls.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe('spawnEditorOnPath', () => {
  let origIsTTY: boolean | undefined;
  let origVisual: string | undefined;
  let origEditor: string | undefined;
  let pauseSpy: ReturnType<typeof vi.spyOn>;
  let resumeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    origIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    origVisual = process.env['VISUAL'];
    origEditor = process.env['EDITOR'];
    delete process.env['VISUAL'];
    process.env['EDITOR'] = 'vim';
    pauseSpy = vi.spyOn(process.stdin, 'pause').mockImplementation(() => process.stdin);
    resumeSpy = vi.spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin);
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
    if (origVisual === undefined) delete process.env['VISUAL'];
    else process.env['VISUAL'] = origVisual;
    if (origEditor === undefined) delete process.env['EDITOR'];
    else process.env['EDITOR'] = origEditor;
    pauseSpy.mockRestore();
    resumeSpy.mockRestore();
  });

  it('refuses without a compositor and never spawns', async () => {
    const { notices, notify } = collector();
    const result = await spawnEditorOnPath({ compositor: null, filePath: '/tmp/x.md', notify });
    expect(result.outcome).toBe('no-tty');
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(notices[0]?.kind).toBe('info');
  });

  it('refuses on a non-TTY stdout and never spawns', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    const { notify } = collector();
    const compositor = makeCompositor();
    const result = await spawnEditorOnPath({
      compositor: compositor as never, filePath: '/tmp/x.md', notify,
    });
    expect(result.outcome).toBe('no-tty');
    expect(mockSpawn).not.toHaveBeenCalled();
    // Never suspended, so nothing to restore.
    expect(compositor.suspendInput).not.toHaveBeenCalled();
  });

  it('refuses with no $VISUAL/$EDITOR configured and never spawns', async () => {
    delete process.env['EDITOR'];
    const { notices, notify } = collector();
    const compositor = makeCompositor();
    const result = await spawnEditorOnPath({
      compositor: compositor as never, filePath: '/tmp/x.md', notify,
    });
    expect(result.outcome).toBe('no-editor');
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(notices[0]?.kind).toBe('error');
    expect(compositor.suspendInput).not.toHaveBeenCalled();
  });

  it('spawns the resolved editor on the given path with inherited stdio', async () => {
    const child = new EventEmitter();
    mockSpawn.mockReturnValue(child as never);
    const compositor = makeCompositor();
    const { notify } = collector();

    const pending = spawnEditorOnPath({
      compositor: compositor as never, filePath: '/tmp/real/AFK.md', notify,
    });
    await flushUntilSpawn();
    child.emit('exit', 0);
    const result = await pending;

    expect(result.outcome).toBe('clean');
    expect(mockSpawn).toHaveBeenCalledWith('vim', ['/tmp/real/AFK.md'], { stdio: 'inherit' });
  });

  it('suspends before spawning and resumes after (both halves of the fd-0 claim)', async () => {
    const child = new EventEmitter();
    mockSpawn.mockReturnValue(child as never);
    const compositor = makeCompositor();
    const { notify } = collector();

    const pending = spawnEditorOnPath({
      compositor: compositor as never, filePath: '/tmp/x.md', notify,
    });
    await flushUntilSpawn();
    expect(compositor.suspendInput).toHaveBeenCalledTimes(1);
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(compositor.resumeInput).not.toHaveBeenCalled();

    child.emit('exit', 0);
    await pending;
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(compositor.resumeInput).toHaveBeenCalledTimes(1);
  });

  it('maps a nonzero exit to `nonzero` and carries the code', async () => {
    const child = new EventEmitter();
    mockSpawn.mockReturnValue(child as never);
    const compositor = makeCompositor();
    const { notify } = collector();

    const pending = spawnEditorOnPath({
      compositor: compositor as never, filePath: '/tmp/x.md', notify,
    });
    await flushUntilSpawn();
    child.emit('exit', 1);
    const result = await pending;

    expect(result).toEqual({ outcome: 'nonzero', exitCode: 1 });
    expect(compositor.resumeInput).toHaveBeenCalledTimes(1);
  });

  it('restores the TTY when spawn throws synchronously', async () => {
    mockSpawn.mockImplementation(() => { throw new Error('ENOENT'); });
    const compositor = makeCompositor();
    const { notify } = collector();

    const result = await spawnEditorOnPath({
      compositor: compositor as never, filePath: '/tmp/x.md', notify,
    });

    expect(result.outcome).toBe('spawn-failed');
    // The restore-always invariant: suspended, so it MUST have resumed.
    expect(compositor.suspendInput).toHaveBeenCalledTimes(1);
    expect(compositor.resumeInput).toHaveBeenCalledTimes(1);
    expect(resumeSpy).toHaveBeenCalledTimes(1);
  });

  it('restores the TTY when the child emits an error event', async () => {
    const child = new EventEmitter();
    mockSpawn.mockReturnValue(child as never);
    const compositor = makeCompositor();
    const { notify } = collector();

    const pending = spawnEditorOnPath({
      compositor: compositor as never, filePath: '/tmp/x.md', notify,
    });
    await flushUntilSpawn();
    child.emit('error', new Error('spawn failed'));
    const result = await pending;

    expect(result.outcome).toBe('spawn-failed');
    expect(compositor.resumeInput).toHaveBeenCalledTimes(1);
  });
});

describe('resolveEditor', () => {
  let origVisual: string | undefined;
  let origEditor: string | undefined;

  beforeEach(() => {
    origVisual = process.env['VISUAL'];
    origEditor = process.env['EDITOR'];
  });

  afterEach(() => {
    if (origVisual === undefined) delete process.env['VISUAL'];
    else process.env['VISUAL'] = origVisual;
    if (origEditor === undefined) delete process.env['EDITOR'];
    else process.env['EDITOR'] = origEditor;
  });

  it('prefers $VISUAL over $EDITOR (POSIX precedence)', () => {
    process.env['VISUAL'] = 'nvim';
    process.env['EDITOR'] = 'vim';
    expect(resolveEditor()).toEqual({ cmd: 'nvim', args: [] });
  });

  it('splits arguments so EDITOR="code --wait" works', () => {
    delete process.env['VISUAL'];
    process.env['EDITOR'] = 'code --wait';
    expect(resolveEditor()).toEqual({ cmd: 'code', args: ['--wait'] });
  });

  it('treats an empty value as unset and returns null', () => {
    process.env['VISUAL'] = '';
    process.env['EDITOR'] = '';
    expect(resolveEditor()).toBeNull();
  });
});
