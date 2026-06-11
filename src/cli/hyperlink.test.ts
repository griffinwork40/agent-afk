import { describe, it, expect, afterEach } from 'vitest';
import {
  hyperlink,
  fileHyperlink,
  supportsHyperlinks,
  hyperlinksEnabled,
  resetHyperlinksEnabledForTest,
  OSC8_CLOSE,
} from './hyperlink.js';
import { stripAnsi, displayWidth } from './display.js';

afterEach(() => resetHyperlinksEnabledForTest());

describe('hyperlink', () => {
  it('wraps text in an ST-terminated OSC 8 open/close pair', () => {
    const out = hyperlink('x.ts', 'file:///tmp/x.ts');
    expect(out).toBe('\x1b]8;;file:///tmp/x.ts\x1b\\x.ts\x1b]8;;\x1b\\');
  });

  it('is zero display width beyond the visible text', () => {
    const out = hyperlink('x.ts', 'file:///Users/me/proj/src/x.ts');
    expect(displayWidth(out)).toBe(displayWidth('x.ts'));
  });

  it('stripAnsi removes the escapes and leaves the visible text', () => {
    const out = hyperlink('x.ts', 'file:///tmp/x.ts');
    expect(stripAnsi(out)).toBe('x.ts');
  });
});

describe('fileHyperlink', () => {
  it('targets the absolute path as a file:// URL', () => {
    const out = fileHyperlink('x.ts', '/Users/me/proj/src/x.ts');
    expect(out).toContain('file:///Users/me/proj/src/x.ts');
    expect(stripAnsi(out)).toBe('x.ts');
  });

  it('percent-encodes spaces, unicode, and control bytes in the URI', () => {
    const out = fileHyperlink('y.ts', '/tmp/a b/x\x07y.ts');
    expect(out).toContain('file:///tmp/a%20b/x%07y.ts');
    // The raw BEL byte must never appear in the emitted sequence.
    expect(out).not.toContain('\x07');
  });

  it('resolves relative input against cwd (pathToFileURL semantics) without throwing', () => {
    // pathToFileURL never throws on string input (relative paths resolve
    // against cwd; lone surrogates are replacement-char-encoded), so the
    // fail-open catch in fileHyperlink is purely defensive. Document the
    // observable behavior: relative input still yields a valid clickable
    // link with intact visible text.
    const out = fileHyperlink('b.ts', 'a/b.ts');
    expect(stripAnsi(out)).toBe('b.ts');
    expect(out).toContain('file://');
  });
});

describe('supportsHyperlinks', () => {
  it('FORCE_HYPERLINK=1 force-enables even without a TTY', () => {
    expect(supportsHyperlinks({ FORCE_HYPERLINK: '1' }, false)).toBe(true);
  });

  it('FORCE_HYPERLINK=0 / false force-disables even on a supported terminal', () => {
    expect(supportsHyperlinks({ FORCE_HYPERLINK: '0', TERM_PROGRAM: 'vscode' }, true)).toBe(false);
    expect(supportsHyperlinks({ FORCE_HYPERLINK: 'false', TERM_PROGRAM: 'vscode' }, true)).toBe(
      false,
    );
  });

  it('disabled when stdout is not a TTY', () => {
    expect(supportsHyperlinks({ TERM_PROGRAM: 'vscode' }, false)).toBe(false);
  });

  it('disabled in CI', () => {
    expect(supportsHyperlinks({ TERM_PROGRAM: 'vscode', CI: 'true' }, true)).toBe(false);
  });

  it.each([
    ['vscode (covers Cursor)', { TERM_PROGRAM: 'vscode' }],
    ['iTerm2', { TERM_PROGRAM: 'iTerm.app' }],
    ['WezTerm', { WEZTERM_PANE: '1' }],
    ['kitty', { KITTY_WINDOW_ID: '1' }],
    ['Ghostty', { TERM: 'xterm-ghostty' }],
    ['Windows Terminal', { WT_SESSION: 'x' }],
    ['Konsole', { KONSOLE_DBUS_SERVICE: 'x' }],
    ['Alacritty', { TERM: 'alacritty' }],
  ] as const)('enabled on %s', (_name, env) => {
    expect(supportsHyperlinks(env, true)).toBe(true);
  });

  it.each([
    ['Apple Terminal', { TERM_PROGRAM: 'Apple_Terminal' }],
    ['Hyper', { TERM_PROGRAM: 'Hyper' }],
    ['tmux (passthrough not configured)', { TMUX: '/tmp/tmux-1000/default,123,0' }],
    ['unknown terminal', {}],
  ] as const)('disabled on %s', (_name, env) => {
    expect(supportsHyperlinks(env, true)).toBe(false);
  });

  it('gates VTE family on VTE_VERSION >= 0.50', () => {
    expect(supportsHyperlinks({ GNOME_TERMINAL_SCREEN: 'x', VTE_VERSION: '5202' }, true)).toBe(
      true,
    );
    expect(supportsHyperlinks({ GNOME_TERMINAL_SCREEN: 'x', VTE_VERSION: '4205' }, true)).toBe(
      false,
    );
    // No advertised version: allow (gnome-terminal sets the screen var
    // and any modern release supports OSC 8).
    expect(supportsHyperlinks({ GNOME_TERMINAL_SCREEN: 'x' }, true)).toBe(true);
  });
});

describe('hyperlinksEnabled cache seam', () => {
  it('resetHyperlinksEnabledForTest pins the value', () => {
    resetHyperlinksEnabledForTest(true);
    expect(hyperlinksEnabled()).toBe(true);
    resetHyperlinksEnabledForTest(false);
    expect(hyperlinksEnabled()).toBe(false);
  });
});

describe('OSC8_CLOSE', () => {
  it('is the ST-terminated empty-URI close sequence', () => {
    expect(OSC8_CLOSE).toBe('\x1b]8;;\x1b\\');
  });
});
