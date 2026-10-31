/**
 * Tests for inline-image-render.ts — terminal protocol detection and
 * the renderInlineImage opt-out / non-TTY guards.
 *
 * @module agent/tools/hooks/inline-image-render.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectTerminalProtocol } from './inline-image-render.js';

// ---------------------------------------------------------------------------
// detectTerminalProtocol
// ---------------------------------------------------------------------------

describe('detectTerminalProtocol', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns "kitty" when TERM=xterm-kitty', () => {
    vi.stubEnv('TERM', 'xterm-kitty');
    vi.stubEnv('TERM_PROGRAM', '');
    expect(detectTerminalProtocol()).toBe('kitty');
  });

  it('returns "kitty" when TERM_PROGRAM=ghostty', () => {
    vi.stubEnv('TERM', '');
    vi.stubEnv('TERM_PROGRAM', 'ghostty');
    expect(detectTerminalProtocol()).toBe('kitty');
  });

  it('returns "kitty" when TERM_PROGRAM=WezTerm (case-insensitive)', () => {
    vi.stubEnv('TERM', '');
    vi.stubEnv('TERM_PROGRAM', 'WezTerm');
    expect(detectTerminalProtocol()).toBe('kitty');
  });

  it('returns "iterm2" when TERM_PROGRAM=iTerm.app', () => {
    vi.stubEnv('TERM', '');
    vi.stubEnv('TERM_PROGRAM', 'iTerm.app');
    expect(detectTerminalProtocol()).toBe('iterm2');
  });

  it('returns "iterm2" when TERM_PROGRAM=iTerm2', () => {
    vi.stubEnv('TERM', '');
    vi.stubEnv('TERM_PROGRAM', 'iTerm2');
    expect(detectTerminalProtocol()).toBe('iterm2');
  });

  it('returns "none" for an unrecognised terminal', () => {
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('TERM_PROGRAM', '');
    vi.stubEnv('TERM_PROGRAM_VERSION', '');
    expect(detectTerminalProtocol()).toBe('none');
  });

  it('returns "none" when TERM/TERM_PROGRAM are unset', () => {
    vi.stubEnv('TERM', '');
    vi.stubEnv('TERM_PROGRAM', '');
    vi.stubEnv('TERM_PROGRAM_VERSION', '');
    expect(detectTerminalProtocol()).toBe('none');
  });

  it('kitty wins when TERM=xterm-kitty and TERM_PROGRAM=iTerm.app', () => {
    vi.stubEnv('TERM', 'xterm-kitty');
    vi.stubEnv('TERM_PROGRAM', 'iTerm.app');
    expect(detectTerminalProtocol()).toBe('kitty');
  });
});

// ---------------------------------------------------------------------------
// renderInlineImage — opt-out guard
// ---------------------------------------------------------------------------

describe('renderInlineImage — AFK_INLINE_IMAGES opt-out', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it('writes nothing when AFK_INLINE_IMAGES=0', async () => {
    vi.stubEnv('AFK_INLINE_IMAGES', '0');
    const { renderInlineImage } = await import('./inline-image-render.js');
    await renderInlineImage({ filePath: '/nonexistent/test.png', toolName: 'image_generate' });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('writes nothing when AFK_INLINE_IMAGES=false', async () => {
    vi.stubEnv('AFK_INLINE_IMAGES', 'false');
    const { renderInlineImage } = await import('./inline-image-render.js');
    await renderInlineImage({ filePath: '/nonexistent/test.png', toolName: 'image_generate' });
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
