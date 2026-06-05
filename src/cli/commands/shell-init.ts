/**
 * `afk shell-init [shell]` — emit the optional shell wrapper that cds
 * the parent shell into a preserved worktree after `afk` exits.
 *
 * The wrapper is a thin function the user adds to their shell rc via:
 *
 *   eval "$(afk shell-init)"          # bash / zsh
 *   afk shell-init fish | source -    # fish
 *
 * Mechanism:
 *   - The wrapper sets AFK_SHELL_WRAPPER=1 so the binary knows it can
 *     suppress the "install the wrapper" hint at exit.
 *   - After `afk` returns, the wrapper reads the marker file written
 *     by `recordCdIntent` (see src/utils/cd-on-exit.ts), deletes it,
 *     and cd's the parent shell into the recorded path if it exists.
 *   - Without the wrapper, the marker file is harmless: every
 *     subsequent `afk` invocation clears it at startup via
 *     `clearCdIntent`.
 *
 * Defaults to the bash/zsh form when no shell is specified (the same
 * function works in both). `fish` requires its own variant.
 *
 * @module cli/commands/shell-init
 */

import type { Command } from 'commander';
import { basename } from 'node:path';
import { env } from '../../config/env.js';
import { getCdIntentPath } from '../../utils/cd-on-exit.js';

type SupportedShell = 'bash' | 'zsh' | 'fish';


function bashZshWrapper(_markerPath: string): string {
  // The `[ ! -L ]` guard rejects a symlink at the marker location as
  // defense-in-depth — an attacker with write access to ~/.afk/state/
  // already has enough leverage to backdoor .zshrc directly, but the
  // symlink guard is cheap insurance.
  // Ordering: `cd && rm` so a failed cd surfaces a warning and leaves
  // the marker in place (vs. `rm; cd` which silently swallows failures
  // and orphans the user in the wrong directory with no recovery).
  //
  // Marker path uses runtime shell expansion (${AFK_HOME:-$HOME/.afk})
  // rather than baking the absolute path at install time. This means
  // the wrapper stays correct if the user moves or re-creates ~/.afk or
  // changes AFK_HOME after sourcing the wrapper. The value of $AFK_HOME
  // at wrapper-eval time (install) is irrelevant; only the runtime value
  // matters when afk exits and the wrapper fires.
  //
  // The `local` builtin used below is bash/zsh (and dash/ash) syntax —
  // NOT in the POSIX standard. ksh93 uses `typeset` instead and would
  // hard-fail parsing this function. The shebang/install instructions
  // explicitly call out bash and zsh; sourcing this output from ksh or
  // a pure-POSIX shell will produce a parse error. The CLI emits a
  // stderr warning when $SHELL resolves to plain `sh` to surface the
  // mismatch early (see registerShellInitCommand).
  return `# >>> afk shell-init >>>
# Auto-cd into a preserved worktree after \`afk\` exits.
# REQUIRES: bash or zsh. Uses \`local\` (also works in dash/ash but
# breaks in ksh93). For fish, use \`afk shell-init fish | source\`.
# Installed via: eval "$(afk shell-init)"  (add to ~/.zshrc or ~/.bashrc)
# WARNING: this function overrides any existing 'afk' alias or function
# in your shell. If you have a custom 'afk' alias, remove it first.
afk() {
  AFK_SHELL_WRAPPER=1 command afk "$@"
  local _afk_rc=$?
  local _afk_marker=\${AFK_HOME:-\$HOME/.afk}/state/last-cwd
  # -f follows symlinks; the additional ! -L check rejects a symlink
  # at the marker path (defense-in-depth — see file header).
  if [ -f "$_afk_marker" ] && [ ! -L "$_afk_marker" ]; then
    local _afk_target
    _afk_target=$(cat "$_afk_marker" 2>/dev/null)
    if [ -n "$_afk_target" ] && [ -d "$_afk_target" ]; then
      if cd "$_afk_target"; then
        rm -f "$_afk_marker"
      else
        echo "afk: warning: could not cd to $_afk_target" >&2
      fi
    else
      rm -f "$_afk_marker"
    fi
  fi
  return $_afk_rc
}
# <<< afk shell-init <<<
`;
}

function fishWrapper(_markerPath: string): string {
  // `set -lx AFK_SHELL_WRAPPER 1` is used instead of the inline
  // `VAR=val cmd` syntax because the inline form only exists in fish
  // ≥ 3.1 (Feb 2020). `set -lx` works back to fish 2.x and produces an
  // equivalent function-local exported variable — propagated to the
  // child `afk` process and only the child, since the variable goes out
  // of scope when the function returns.
  //
  // Symlink guard and cd-then-rm ordering match bash/zsh — see above.
  //
  // Marker path uses runtime shell variable expansion rather than baking
  // the absolute path at install time. Fish syntax for a conditional
  // default: test whether AFK_HOME is set, use it if so, else fall back
  // to "$HOME/.afk". This keeps the wrapper correct if the user relocates
  // ~/.afk or sets AFK_HOME differently in a future shell session.
  return `# >>> afk shell-init >>>
# Auto-cd into a preserved worktree after \`afk\` exits.
# Installed via: afk shell-init fish | source
# WARNING: this function overrides any existing 'afk' alias or function
# in your shell. If you have a custom 'afk' alias, remove it first.
function afk
    set -lx AFK_SHELL_WRAPPER 1
    command afk $argv
    set -l _afk_rc $status
    if set -q AFK_HOME; and test -n "$AFK_HOME"
        set -l _afk_marker "$AFK_HOME/state/last-cwd"
    else
        set -l _afk_marker "$HOME/.afk/state/last-cwd"
    end
    if test -f "$_afk_marker"; and not test -L "$_afk_marker"
        set -l _afk_target (cat "$_afk_marker" 2>/dev/null)
        if test -n "$_afk_target"; and test -d "$_afk_target"
            if cd "$_afk_target"
                rm -f "$_afk_marker"
            else
                echo "afk: warning: could not cd to $_afk_target" >&2
            end
        else
            rm -f "$_afk_marker"
        end
    end
    return $_afk_rc
end
# <<< afk shell-init <<<
`;
}

/**
 * Pure renderer — exported so tests can assert the generated text
 * without spawning the CLI.
 */
export function renderShellInit(shell: SupportedShell, markerPath: string): string {
  switch (shell) {
    case 'fish':
      return fishWrapper(markerPath);
    case 'bash':
    case 'zsh':
      return bashZshWrapper(markerPath);
  }
}

/**
 * Detect the user's shell from `$SHELL` when no explicit argument
 * was given. Falls back to `'bash'` (the safest default — the wrapper
 * works in both bash and zsh).
 *
 * Exported so the install-hint emitter (in worktree.ts) can stay in
 * sync with the default the command itself picks.
 */
export function detectShellFromEnv(shellEnv: string | undefined): SupportedShell {
  if (!shellEnv) return 'bash';
  // Strip flags before extracting the basename: $SHELL is normally just a
  // path (e.g. /usr/local/bin/zsh) but some configurations include options
  // (e.g. /usr/local/bin/zsh -l or "zsh -l"), which makes basename() return
  // "zsh -l" — a string that never matches any recognised shell name, causing
  // silent fallback to bash even when the user runs zsh.
  const name = basename(shellEnv.split(/\s/)[0] ?? shellEnv);
  if (name === 'zsh' || name === 'bash' || name === 'fish') return name;
  return 'bash';
}

export function registerShellInitCommand(program: Command): void {
  program
    .command('shell-init [shell]')
    .description(
      'Emit the optional `afk` shell wrapper that cd\'s the parent shell into a preserved worktree on exit. ' +
        'Default: auto-detect from $SHELL (falls back to bash). Install: `eval "$(afk shell-init)"` (or pipe to `source` in fish). ' +
        'NOTE: the emitted function overrides any existing `afk` alias or function in your shell.',
    )
    .action((shell: string | undefined) => {
      const resolved: SupportedShell =
        shell === undefined || shell === ''
          ? // Default: derive from $SHELL when present. zsh users without an
            // explicit argument used to get the bash form (which works by
            // accident — same syntax). Auto-detection makes the emitted
            // header comment accurate and protects against any future
            // bash/zsh divergence in the wrapper.
            detectShellFromEnv(env.SHELL)
          : shell === 'bash' || shell === 'zsh' || shell === 'fish'
            ? shell
            : ((): never => {
                program.error(`unknown shell: ${shell}. Choose from: bash, zsh, fish`);
                throw new Error('unreachable'); // program.error exits; satisfy types
              })();

      // Warn (stderr only — stdout is consumed by `eval`) when the user's
      // login shell is one that is known to be incompatible with the emitted
      // wrapper. The bash/zsh wrapper uses `local`, which is NOT in POSIX and
      // fails in ksh93 (use `typeset`) and is unavailable in plain sh/dash.
      // ksh / ksh93 / dash users get a parse error on `local` at shell
      // startup if they source the bash/zsh wrapper — surface this early
      // rather than letting it corrupt their shell silently.
      const shellEnv = env.SHELL;
      const shellBasename =
        shellEnv !== undefined && shellEnv !== ''
          ? basename(shellEnv.split(/\s/)[0] ?? shellEnv)
          : '';
      const unsupportedShells = ['sh', 'ksh', 'ksh93', 'dash'];
      if (
        (shell === undefined || shell === '') &&
        shellBasename !== '' &&
        unsupportedShells.includes(shellBasename)
      ) {
        process.stderr.write(
          `afk shell-init: WARNING: $SHELL=${shellBasename} is not supported. ` +
            'The emitted wrapper uses `local` which is a bash/zsh extension ' +
            `and produces a parse error in ${shellBasename}. ` +
            'Use bash, zsh, or fish instead.\n',
        );
      }

      const script = renderShellInit(resolved, getCdIntentPath());
      // CONTRACT: this stdout stream is `eval`'d verbatim by the parent
      // shell when the user runs `eval "$(afk shell-init)"`. Do NOT add
      // banners, logs, or diagnostics here — any extra output would
      // corrupt the eval'd script and break the user's shell.
      // Diagnostics must go to stderr exclusively in this command path.
      process.stdout.write(script);
    });
}
