/**
 * Per-terminal spawn planning — pure functions that build the exact command
 * to open a new tab/window, with NO side effects. `trySpawnTab` (index.ts)
 * executes the plan; keeping construction pure makes every command string
 * unit-testable without launching anything.
 *
 * Only fast-returning "client" commands are modelled here (tmux, wezterm cli,
 * kitten @, wt, osascript, gnome-terminal, konsole). Each hands off to the
 * terminal and exits immediately, so the executor can use spawnSync and read a
 * reliable success/failure status. Terminals whose only mechanism is to exec
 * the terminal binary directly and block (alacritty -e, ghostty +new-window on
 * Linux) are intentionally modelled as capability 'none' → the caller prints
 * the resume command instead of risking a hung REPL.
 */

import { resolve } from 'node:path';
import { shellQuoteToken } from '../resume-command.js';
import type { AgentModelInput } from '../../agent/types.js';
import type { SpawnCapability, TerminalKind } from './detect.js';

export interface ResumeInvocation {
  /** Executable + args that launch the forked REPL (no shell). */
  argv: string[];
  /** Single shell-command-string equivalent, each token shell-quoted. */
  shellCommand: string;
  /** Working directory the new session should start in. */
  cwd: string;
  /**
   * Whether this invocation can be re-launched by a child process. False when
   * the current process was started from a TypeScript entrypoint (tsx dev
   * mode): re-running `node foo.ts` would fail, so we decline to spawn and let
   * the caller print the resume command instead.
   */
  spawnable: boolean;
}

export interface SpawnPlan {
  kind: TerminalKind;
  capability: SpawnCapability;
  /** Present only when capability !== 'none'. */
  exec?: { cmd: string; args: string[] };
}

/**
 * Build the command that re-launches THIS afk against the forked session id.
 *
 * Uses process.execPath + argv[1] rather than a bare `afk` so the spawn points
 * at exactly the binary currently running (no PATH ambiguity across multiple
 * installs). The human-facing resume string printed by /fork still uses the
 * pretty `afk interactive …` form (formatResumeCommand).
 */
export function resolveResumeInvocation(
  forkId: string,
  model: AgentModelInput,
  cwd: string,
): ResumeInvocation {
  const scriptPath = resolve(process.argv[1] ?? '');
  const argv = [process.execPath, scriptPath, 'interactive'];
  if (typeof model === 'string' && model.length > 0) {
    argv.push('--model', model);
  }
  argv.push('--resume', forkId);

  const shellCommand = argv.map(shellQuoteToken).join(' ');
  const spawnable = scriptPath.length > 0 && !scriptPath.endsWith('.ts');
  return { argv, shellCommand, cwd, spawnable };
}

/** Escape a string for embedding inside an AppleScript double-quoted literal. */
function osaEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** A shell command that cd's into cwd first, then runs the invocation. */
function cdThen(inv: ResumeInvocation): string {
  return `cd ${shellQuoteToken(inv.cwd)} && ${inv.shellCommand}`;
}

function itermScript(inv: ResumeInvocation): string {
  return `tell application "iTerm" to tell current window to create tab with default profile command "${osaEscape(cdThen(inv))}"`;
}

function appleTerminalScript(inv: ResumeInvocation): string {
  // Terminal.app has no reliable AppleScript "new tab" verb; `do script`
  // opens a new window (and returns immediately). Honest capability: window.
  return `tell application "Terminal" to do script "${osaEscape(cdThen(inv))}"`;
}

function ghosttyScript(inv: ResumeInvocation): string {
  // Ghostty macOS AppleScript (v1.3+, on by default unless macos-applescript
  // is disabled). Sets command + working dir on a fresh surface config.
  return [
    'tell application "Ghostty"',
    'set cfg to new surface configuration',
    `set command of cfg to "${osaEscape(inv.shellCommand)}"`,
    `set initial working directory of cfg to "${osaEscape(inv.cwd)}"`,
    'new tab in (front window) with configuration cfg',
    'end tell',
  ].join('\n');
}

/**
 * Plan how to open the forked session for a detected terminal. Pure: returns
 * the command to run (or capability 'none' when no safe mechanism exists).
 */
export function planSpawn(
  kind: TerminalKind,
  inv: ResumeInvocation,
  platform: NodeJS.Platform = process.platform,
): SpawnPlan {
  switch (kind) {
    case 'tmux':
      // One trailing arg → tmux runs it via `sh -c`. -c sets the cwd.
      return { kind, capability: 'tab', exec: { cmd: 'tmux', args: ['new-window', '-c', inv.cwd, inv.shellCommand] } };
    case 'wezterm':
      return { kind, capability: 'tab', exec: { cmd: 'wezterm', args: ['cli', 'spawn', '--cwd', inv.cwd, '--', ...inv.argv] } };
    case 'kitty':
      return { kind, capability: 'tab', exec: { cmd: 'kitten', args: ['@', 'launch', '--type=tab', `--cwd=${inv.cwd}`, ...inv.argv] } };
    case 'windows-terminal':
      return { kind, capability: 'tab', exec: { cmd: 'wt', args: ['-w', '0', 'new-tab', '-d', inv.cwd, ...inv.argv] } };
    case 'iterm2':
      return { kind, capability: 'tab', exec: { cmd: 'osascript', args: ['-e', itermScript(inv)] } };
    case 'apple-terminal':
      return { kind, capability: 'window', exec: { cmd: 'osascript', args: ['-e', appleTerminalScript(inv)] } };
    case 'ghostty':
      if (platform === 'darwin') {
        return { kind, capability: 'tab', exec: { cmd: 'osascript', args: ['-e', ghosttyScript(inv)] } };
      }
      // Linux Ghostty has no new-tab CLI; +new-window blocks as first instance.
      return { kind, capability: 'none' };
    case 'gnome-terminal':
      return { kind, capability: 'tab', exec: { cmd: 'gnome-terminal', args: ['--tab', `--working-directory=${inv.cwd}`, '--', ...inv.argv] } };
    case 'konsole':
      return { kind, capability: 'tab', exec: { cmd: 'konsole', args: ['--new-tab', '--workdir', inv.cwd, '-e', ...inv.argv] } };
    case 'vscode':
    case 'alacritty':
    case 'hyper':
    case 'unknown':
      return { kind, capability: 'none' };
  }
}
