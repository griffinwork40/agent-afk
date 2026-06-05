/**
 * Tests for `afk shell-init` script rendering.
 *
 * The rendered text is what users source into their shell rc, so the
 * tests pin the exact shape contracts the wrapper relies on:
 *
 *   - Sets AFK_SHELL_WRAPPER=1 before invoking the real binary so the
 *     binary can suppress the install-hint on dirty exits.
 *   - Reads then `rm -f`s the marker so the wrapper is single-shot per
 *     `afk` invocation (no risk of double-cd on a later session).
 *   - Verifies the path is a directory before `cd`ing so a deleted /
 *     stale worktree never crashes the user's shell.
 *   - Returns the binary's exit code so `&&` chains downstream still
 *     work (e.g. `afk i -w && pnpm test`).
 *   - Uses POSIX `[ ... ]` for bash/zsh and `test ...` for fish.
 */

import { describe, expect, it } from 'vitest';
import { detectShellFromEnv, renderShellInit } from './shell-init.js';

describe('renderShellInit', () => {
  const MARKER = '/tmp/test-afk-home/state/last-cwd';

  describe('bash/zsh', () => {
    it('emits a function named `afk` that wraps `command afk`', () => {
      const out = renderShellInit('bash', MARKER);
      expect(out).toMatch(/afk\(\)\s*\{/);
      expect(out).toContain('command afk "$@"');
    });

    it('sets AFK_SHELL_WRAPPER=1 in the wrapped invocation', () => {
      const out = renderShellInit('zsh', MARKER);
      expect(out).toContain('AFK_SHELL_WRAPPER=1 command afk "$@"');
    });

    it('captures and returns the exit code of the wrapped invocation', () => {
      const out = renderShellInit('bash', MARKER);
      expect(out).toContain('_afk_rc=$?');
      expect(out).toMatch(/return\s+\$_afk_rc/);
    });

    it('uses runtime AFK_HOME shell expansion for the marker path (bash/zsh)', () => {
      // The wrapper must resolve the marker path at runtime via
      // ${AFK_HOME:-$HOME/.afk}/state/last-cwd so that moving AFK_HOME or
      // installing the wrapper before AFK_HOME is set still works correctly.
      // The markerPath argument is ignored for runtime-expansion shells.
      const out = renderShellInit('bash', MARKER);
      expect(out).toContain('_afk_marker=${AFK_HOME:-$HOME/.afk}/state/last-cwd');
      // Ensure the baked absolute path is NOT present (regression guard).
      expect(out).not.toContain(`_afk_marker='${MARKER}'`);
    });

    it('marker path arg is ignored — runtime expansion used instead (bash/zsh)', () => {
      // markerPath is accepted for API compatibility but the wrapper uses
      // ${AFK_HOME:-$HOME/.afk}/state/last-cwd at runtime.
      const tricky = `/path/with'quote/last-cwd`;
      const out = renderShellInit('bash', tricky);
      expect(out).not.toContain(tricky);
      expect(out).toContain('${AFK_HOME:-$HOME/.afk}/state/last-cwd');
    });

    it('marker path with metacharacters is ignored (runtime expansion, no escaping needed)', () => {
      // With runtime expansion, AFK_HOME metacharacter-safety is the shell's
      // responsibility via the ${AFK_HOME:-...} syntax — no escaping in the
      // emitted wrapper text.
      const weird = `/Users/Jane Doe/.afk/$x/\`tick\`/last-cwd`;
      const out = renderShellInit('bash', weird);
      expect(out).not.toContain(weird);
      expect(out).toContain('${AFK_HOME:-$HOME/.afk}/state/last-cwd');
    });

    it('reads then deletes the marker file (single-shot semantics)', () => {
      const out = renderShellInit('bash', MARKER);
      expect(out).toContain('cat "$_afk_marker"');
      expect(out).toContain('rm -f "$_afk_marker"');
      // Read must happen before delete so we don't lose the target path.
      const catIdx = out.indexOf('cat "$_afk_marker"');
      const rmIdx = out.indexOf('rm -f "$_afk_marker"');
      expect(catIdx).toBeLessThan(rmIdx);
    });

    it('cds only after a `-d` directory check on the recorded target', () => {
      const out = renderShellInit('bash', MARKER);
      // Both -n (non-empty) and -d (exists as dir) must guard the cd.
      expect(out).toMatch(/\[\s+-n\s+"\$_afk_target"\s+\]\s+&&\s+\[\s+-d\s+"\$_afk_target"\s+\]/);
      expect(out).toContain('cd "$_afk_target"');
    });

    it('rejects a symlink at the marker path (defense-in-depth)', () => {
      const out = renderShellInit('bash', MARKER);
      // -f follows symlinks; combine with -L test to reject symlinks.
      expect(out).toContain('[ ! -L "$_afk_marker" ]');
    });

    it('only removes the marker after a successful cd (cd-then-rm ordering)', () => {
      const out = renderShellInit('bash', MARKER);
      // The cd success branch is what triggers the rm; a failed cd
      // surfaces a warning and leaves the marker for inspection.
      expect(out).toMatch(/if cd "\$_afk_target"; then[\s\S]*?rm -f "\$_afk_marker"/);
      expect(out).toContain('warning: could not cd to');
    });

    it('zsh shell produces the same output as bash (single wrapper covers both)', () => {
      expect(renderShellInit('zsh', MARKER)).toBe(renderShellInit('bash', MARKER));
    });

    it('wraps the function in commented sentinel markers for safe re-evaluation', () => {
      const out = renderShellInit('bash', MARKER);
      expect(out).toContain('# >>> afk shell-init >>>');
      expect(out).toContain('# <<< afk shell-init <<<');
    });

    it('emits a "REQUIRES: bash or zsh" guard comment (warns sourcing in pure-POSIX shells)', () => {
      // `local` is bash/zsh/dash/ash but NOT POSIX or ksh93. The guard
      // comment is documentation only — the actual prevention is upstream
      // in the CLI command (`registerShellInitCommand` emits a stderr
      // warning when $SHELL=sh). But surfacing the requirement at the top
      // of the eval'd output catches a user who copy-pastes the wrapper
      // into the wrong rc file.
      const out = renderShellInit('bash', MARKER);
      expect(out).toMatch(/REQUIRES:\s*bash or zsh/);
    });
  });

  describe('fish', () => {
    it('emits a fish `function afk … end` block', () => {
      const out = renderShellInit('fish', MARKER);
      expect(out).toMatch(/function\s+afk\b/);
      expect(out).toMatch(/^end\s*$/m);
    });

    it('exports AFK_SHELL_WRAPPER=1 via fish-version-agnostic `set -lx`', () => {
      // The inline `VAR=val cmd` env-prefix syntax only exists in fish 3.1+
      // (Feb 2020); `set -lx` works back to fish 2.x. A function-local
      // exported variable propagates to the child process and goes out of
      // scope when the function returns — equivalent semantics.
      const out = renderShellInit('fish', MARKER);
      expect(out).toContain('set -lx AFK_SHELL_WRAPPER 1');
      expect(out).toContain('command afk $argv');
      // Negative assertion: the old fish-3.1-only syntax must not leak back.
      expect(out).not.toContain('AFK_SHELL_WRAPPER=1 command afk');
    });

    it('captures $status (fish equivalent of $?)', () => {
      const out = renderShellInit('fish', MARKER);
      expect(out).toContain('set -l _afk_rc $status');
      expect(out).toMatch(/return\s+\$_afk_rc/);
    });

    it('uses runtime AFK_HOME shell expansion for the marker path (fish)', () => {
      const out = renderShellInit('fish', MARKER);
      expect(out).toContain('set -q AFK_HOME');
      expect(out).toContain('$AFK_HOME/state/last-cwd');
      expect(out).toContain('$HOME/.afk/state/last-cwd');
      expect(out).not.toContain(`'${MARKER}'`);
    });

    it('marker path arg is ignored in fish (runtime expansion used instead)', () => {
      const tricky = `/path/with'quote/last-cwd`;
      const out = renderShellInit('fish', tricky);
      expect(out).not.toContain(tricky);
      expect(out).toContain('$AFK_HOME/state/last-cwd');
      expect(out).toContain('$HOME/.afk/state/last-cwd');
    });

    it('uses `test -d` to guard the cd', () => {
      const out = renderShellInit('fish', MARKER);
      expect(out).toContain('test -n "$_afk_target"');
      expect(out).toContain('test -d "$_afk_target"');
      expect(out).toContain('cd "$_afk_target"');
    });

    it('rejects a symlink at the marker path (defense-in-depth)', () => {
      const out = renderShellInit('fish', MARKER);
      expect(out).toContain('not test -L "$_afk_marker"');
    });

    it('reads then deletes the marker file', () => {
      const out = renderShellInit('fish', MARKER);
      expect(out).toContain('cat "$_afk_marker"');
      expect(out).toContain('rm -f "$_afk_marker"');
    });

    it('only removes the marker after a successful cd (cd-then-rm ordering)', () => {
      const out = renderShellInit('fish', MARKER);
      expect(out).toMatch(/if cd "\$_afk_target"[\s\S]*?rm -f "\$_afk_marker"/);
      expect(out).toContain('warning: could not cd to');
    });

    it('wraps in sentinel comments', () => {
      const out = renderShellInit('fish', MARKER);
      expect(out).toContain('# >>> afk shell-init >>>');
      expect(out).toContain('# <<< afk shell-init <<<');
    });

    it('install-hint comment uses fish-correct `| source` syntax (not bash `eval`)', () => {
      const out = renderShellInit('fish', MARKER);
      expect(out).toContain('afk shell-init fish | source');
      expect(out).not.toContain('eval "$(afk shell-init)"');
    });

    it('fish wrapper uses runtime expansion — trailing-backslash in path irrelevant', () => {
      const trailing = '/some/path\\';
      const out = renderShellInit('fish', trailing);
      expect(out).not.toContain(trailing);
      expect(out).toContain('$HOME/.afk/state/last-cwd');
    });

    it('fish wrapper uses runtime expansion — embedded-backslash in path irrelevant', () => {
      const embedded = '/path/with\\inside/last-cwd';
      const out = renderShellInit('fish', embedded);
      expect(out).not.toContain(embedded);
      expect(out).toContain('$HOME/.afk/state/last-cwd');
    });
  });
});

describe('detectShellFromEnv', () => {
  it('returns bash when SHELL is unset', () => {
    expect(detectShellFromEnv(undefined)).toBe('bash');
    expect(detectShellFromEnv('')).toBe('bash');
  });

  it('detects zsh from /bin/zsh', () => {
    expect(detectShellFromEnv('/bin/zsh')).toBe('zsh');
  });

  it('detects bash from /bin/bash', () => {
    expect(detectShellFromEnv('/bin/bash')).toBe('bash');
  });

  it('detects fish from any path ending in /fish', () => {
    expect(detectShellFromEnv('/usr/local/bin/fish')).toBe('fish');
    expect(detectShellFromEnv('/opt/homebrew/bin/fish')).toBe('fish');
  });

  it('falls back to bash for unknown shells (ksh, csh, etc.)', () => {
    expect(detectShellFromEnv('/bin/ksh')).toBe('bash');
    expect(detectShellFromEnv('/bin/tcsh')).toBe('bash');
  });

  it('strips flags from $SHELL before detecting shell name', () => {
    // $SHELL=/usr/local/bin/zsh -l  → basename of the path part → 'zsh'
    // Without flag-stripping, basename('/usr/local/bin/zsh -l') === 'zsh -l'
    // which matches nothing and silently falls back to bash.
    expect(detectShellFromEnv('/usr/local/bin/zsh -l')).toBe('zsh');
    expect(detectShellFromEnv('/bin/bash --login')).toBe('bash');
    expect(detectShellFromEnv('/usr/local/bin/fish -i')).toBe('fish');
    // A bare shell name with a flag should also work.
    expect(detectShellFromEnv('zsh -l')).toBe('zsh');
  });
});
