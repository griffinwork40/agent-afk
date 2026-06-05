/**
 * Tests for clipboard image paste (Ctrl+V) and attachment-pop (Backspace)
 * in src/cli/input-box.ts
 *
 * Strategy:
 * - Unit tests for state helpers (input-box-state.ts)
 * - Integration smoke tests for the full readWithAutocomplete flow
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { readWithAutocomplete } from '../input-box.js';
import type { ImageAttachment } from '../input/attachments.js';

// Mock the clipboard-image module
vi.mock('../input/clipboard-image.js', () => ({
  readClipboardImage: vi.fn(),
}));

import { readClipboardImage } from '../input/clipboard-image.js';

const mockReadClipboardImage = readClipboardImage as ReturnType<typeof vi.fn>;

/**
 * Create a mock TTY for testing.
 * Simulates stdin/stdout with event emitters.
 */
function createMockTTY() {
  const stdin = new EventEmitter() as any;
  const stdout = new EventEmitter() as any;
  const originalStdout = process.stdout;
  const originalStdin = process.stdin;

  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = vi.fn(() => {
    stdin.isRaw = true;
  });
  stdin.resume = vi.fn();
  stdin.on = EventEmitter.prototype.on;
  stdin.once = EventEmitter.prototype.once;
  stdin.removeListener = EventEmitter.prototype.removeListener;
  stdin.off = EventEmitter.prototype.off;
  stdin.emit = EventEmitter.prototype.emit;

  stdout.isTTY = true;
  stdout.columns = 80;
  stdout.write = vi.fn();
  stdout.on = EventEmitter.prototype.on;
  stdout.once = EventEmitter.prototype.once;
  stdout.removeListener = EventEmitter.prototype.removeListener;
  stdout.off = EventEmitter.prototype.off;
  stdout.emit = EventEmitter.prototype.emit;

  return { stdin, stdout, originalStdin, originalStdout };
}

/**
 * Create a test PNG attachment fixture.
 */
function createTestPngAttachment(): ImageAttachment {
  // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pngData = Buffer.concat([pngHeader, Buffer.alloc(100, 0x00)]);

  return {
    id: 'test-png-1',
    mediaType: 'image/png',
    bytes: pngData,
    sizeBytes: pngData.byteLength,
  };
}

describe('readWithAutocomplete with attachments', () => {
  let tty: ReturnType<typeof createMockTTY>;

  beforeEach(() => {
    tty = createMockTTY();
    vi.spyOn(process, 'stdout', 'get').mockReturnValue(tty.stdout as any);
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(tty.stdin as any);
    mockReadClipboardImage.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Ctrl+V with PNG attachment → appends attachment + renders status line', async () => {
    const pngAttachment = createTestPngAttachment();
    mockReadClipboardImage.mockResolvedValue(pngAttachment);

    const promise = readWithAutocomplete({
      rl: {} as any,
      promptFn: () => '> ',
    });

    // Give the promise time to set up event handlers
    await new Promise((resolve) => setImmediate(resolve));

    // Fire Ctrl+V
    tty.stdin.emit('keypress', undefined, { name: 'v', ctrl: true });

    // Wait for async clipboard read and repaint
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Now submit with Enter to complete the promise
    tty.stdin.emit('keypress', undefined, { name: 'return' });

    const result = await promise;

    expect(result).toEqual({
      text: '',
      attachments: [pngAttachment],
    });

    // Check that status line was rendered at some point
    const writeCallsStr = tty.stdout.write.mock.calls
      .map((call: unknown[]) => call[0])
      .join('');
    expect(writeCallsStr).toContain('[1 image attached');
  });

  it('Ctrl+V with empty clipboard → no state change, no status line', async () => {
    mockReadClipboardImage.mockResolvedValue(null);

    const promise = readWithAutocomplete({
      rl: {} as any,
      promptFn: () => '> ',
    });

    await new Promise((resolve) => setImmediate(resolve));

    // Fire Ctrl+V
    tty.stdin.emit('keypress', undefined, { name: 'v', ctrl: true });

    // Wait for clipboard read
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Submit
    tty.stdin.emit('keypress', undefined, { name: 'return' });

    const result = await promise;

    expect(result.attachments).toHaveLength(0);
    expect(result.text).toBe('');

    // Status line should NOT appear
    const writeCallsStr = tty.stdout.write.mock.calls
      .map((call: unknown[]) => call[0])
      .join('');
    expect(writeCallsStr).not.toContain('image attached');
  });

  it('submit with attachment → resolves with correct shape', async () => {
    const pngAttachment = createTestPngAttachment();
    mockReadClipboardImage.mockResolvedValue(pngAttachment);

    const promise = readWithAutocomplete({
      rl: {} as any,
      promptFn: () => '> ',
    });

    await new Promise((resolve) => setImmediate(resolve));

    // Attach via Ctrl+V
    tty.stdin.emit('keypress', undefined, { name: 'v', ctrl: true });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Submit
    tty.stdin.emit('keypress', undefined, { name: 'return' });

    const result = await promise;

    // Result must have both text and attachments keys
    expect(result).toHaveProperty('text');
    expect(result).toHaveProperty('attachments');
    expect(result.text).toBe('');
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toEqual(pngAttachment);
  });

  it('submit with no attachment → attachments is empty array, not undefined', async () => {
    const promise = readWithAutocomplete({
      rl: {} as any,
      promptFn: () => '> ',
    });

    await new Promise((resolve) => setImmediate(resolve));

    // Submit immediately without attaching anything
    tty.stdin.emit('keypress', undefined, { name: 'return' });

    const result = await promise;

    // Must be an array, even if empty
    expect(Array.isArray(result.attachments)).toBe(true);
    expect(result.attachments).toHaveLength(0);
  });

  it('multiple Ctrl+V commands accumulate attachments', async () => {
    const png1 = createTestPngAttachment();
    const png2 = { ...createTestPngAttachment(), id: 'test-png-2' };

    mockReadClipboardImage
      .mockResolvedValueOnce(png1)
      .mockResolvedValueOnce(png2);

    const promise = readWithAutocomplete({
      rl: {} as any,
      promptFn: () => '> ',
    });

    await new Promise((resolve) => setImmediate(resolve));

    // Attach first
    tty.stdin.emit('keypress', undefined, { name: 'v', ctrl: true });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Attach second
    tty.stdin.emit('keypress', undefined, { name: 'v', ctrl: true });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Submit
    tty.stdin.emit('keypress', undefined, { name: 'return' });
    const result = await promise;

    expect(result.attachments).toHaveLength(2);
    expect(result.attachments[0]).toEqual(png1);
    expect(result.attachments[1]).toEqual(png2);
  });

  it('Ctrl+X discards the most-recently-pasted attachment', async () => {
    const pngAttachment = createTestPngAttachment();
    mockReadClipboardImage.mockResolvedValue(pngAttachment);

    const promise = readWithAutocomplete({
      rl: {} as any,
      promptFn: () => '> ',
    });

    await new Promise((resolve) => setImmediate(resolve));

    // Paste an image
    tty.stdin.emit('keypress', undefined, { name: 'v', ctrl: true });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Discard it via Ctrl+X
    tty.stdin.emit('keypress', undefined, { name: 'x', ctrl: true });

    // Wait one tick so the Return key is not treated as a burst continuation
    // (the burst detection window is 8ms; firing Return in the same tick as
    // Ctrl+X would cause it to insert a newline rather than submit).
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Submit
    tty.stdin.emit('keypress', undefined, { name: 'return' });

    const result = await promise;

    // Attachment must be gone
    expect(result.attachments).toHaveLength(0);
    expect(result.attachments).toEqual([]);
    expect(result.text).toBe('');
  });

  it('result type is ReadWithAutocompleteResult with text and attachments', async () => {
    const promise = readWithAutocomplete({
      rl: {} as any,
      promptFn: () => '> ',
    });

    await new Promise((resolve) => setImmediate(resolve));

    tty.stdin.emit('keypress', undefined, { name: 'return' });

    const result = await promise;

    // TypeScript would catch this at compile time, but verify at runtime
    expect(typeof result).toBe('object');
    expect('text' in result).toBe(true);
    expect('attachments' in result).toBe(true);
    expect(typeof result.text).toBe('string');
    expect(Array.isArray(result.attachments)).toBe(true);
  });
});

/**
 * Part A: clipboardFailureMsg status line.
 *
 * When readClipboardImage() returns null (no image on clipboard), the reader
 * must render a "[clipboard: no image found]" notice in the status row and
 * clear it on the next repaint.
 */
describe('clipboardFailureMsg status line (Part A)', () => {
  let tty: ReturnType<typeof createMockTTY>;

  beforeEach(() => {
    tty = createMockTTY();
    vi.spyOn(process, 'stdout', 'get').mockReturnValue(tty.stdout as any);
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(tty.stdin as any);
    mockReadClipboardImage.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Ctrl+V with null clipboard → renders [clipboard: no image found] in status row', async () => {
    mockReadClipboardImage.mockResolvedValue(null);

    const promise = readWithAutocomplete({
      rl: {} as any,
      promptFn: () => '> ',
    });

    await new Promise((resolve) => setImmediate(resolve));

    // Fire Ctrl+V — clipboard returns null
    tty.stdin.emit('keypress', undefined, { name: 'v', ctrl: true });

    // Wait for async clipboard read + schedulePaint to fire
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Submit to settle the promise
    tty.stdin.emit('keypress', undefined, { name: 'return' });
    await promise;

    const output = tty.stdout.write.mock.calls
      .map((call: unknown[]) => call[0])
      .join('');
    expect(output).toContain('[clipboard: no image found]');
  });

  it('failure message clears on subsequent repaint (paint-clear strategy)', async () => {
    mockReadClipboardImage.mockResolvedValue(null);

    const promise = readWithAutocomplete({
      rl: {} as any,
      promptFn: () => '> ',
    });

    await new Promise((resolve) => setImmediate(resolve));

    // Trigger failure notice
    tty.stdin.emit('keypress', undefined, { name: 'v', ctrl: true });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Clear the write spy so we can measure post-failure repaints only
    tty.stdout.write.mockClear();

    // Fire a keypress to trigger another repaint (should clear the message)
    tty.stdin.emit('keypress', 'a', { name: 'a' });
    await new Promise((resolve) => setImmediate(resolve));

    // Submit
    await new Promise((resolve) => setTimeout(resolve, 20));
    tty.stdin.emit('keypress', undefined, { name: 'return' });
    await promise;

    // After the clearance repaint, subsequent writes must NOT contain the failure message
    const postClearOutput = tty.stdout.write.mock.calls
      .map((call: unknown[]) => call[0])
      .join('');
    expect(postClearOutput).not.toContain('[clipboard: no image found]');
  });

  it('bracketed-paste empty → null clipboard → renders failure message', async () => {
    mockReadClipboardImage.mockResolvedValue(null);

    const promise = readWithAutocomplete({
      rl: {} as any,
      promptFn: () => '> ',
    });

    await new Promise((resolve) => setImmediate(resolve));

    // Simulate empty bracketed paste (start marker → end marker with no chars in between)
    tty.stdin.emit('keypress', undefined, { sequence: '\x1b[200~' });
    tty.stdin.emit('keypress', undefined, { sequence: '\x1b[201~' });

    // Wait for async clipboard probe
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Submit
    tty.stdin.emit('keypress', undefined, { name: 'return' });
    await promise;

    const output = tty.stdout.write.mock.calls
      .map((call: unknown[]) => call[0])
      .join('');
    expect(output).toContain('[clipboard: no image found]');
  });
});
