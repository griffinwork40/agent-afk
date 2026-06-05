/**
 * Surface-agnostic no-echo secret prompter.
 *
 * Extracted from `src/telegram/setup-wizard.ts` so both the Telegram setup
 * wizard and the auth wizard share a single hardened implementation. Fixes S1:
 * auth wizard echoed every keystroke to stdout through readline's default echo.
 *
 * Contract:
 *   - TTY context  → raw-mode char loop, characters masked (not printed).
 *   - Non-TTY      → process exits with a helpful error; there is no safe
 *     fallback for non-interactive callers — they must supply secrets via
 *     environment variables or config files.
 *
 * @module utils/prompt-secret
 */

import chalk from 'chalk';

/**
 * Prompt for a secret value without echoing characters to the terminal.
 *
 * Requires an interactive TTY. Non-interactive callers must supply secrets via
 * environment variables or `~/.afk/config/afk.env`. Falling back to a plain
 * readline `question()` would echo every keystroke — we refuse rather than
 * silently regress the masking guarantee.
 *
 * @param question  - The prompt text written to stdout (e.g. "API key: ").
 * @returns         A Promise that resolves to the trimmed input string.
 */
export function promptSecret(question: string): Promise<string> {
  // Non-TTY guard — external constraint: raw mode requires an interactive TTY.
  // Refusing here is intentional: silent fallback to readline would echo keys.
  if (!process.stdin.isTTY) {
    console.error(
      chalk.red(`Cannot securely prompt for secret on a non-TTY stdin: "${question.trim()}"`),
    );
    console.error(
      chalk.gray(
        '  Supply the token via environment variable or ~/.afk/config/afk.env instead.',
      ),
    );
    process.exit(1);
  }

  return new Promise((resolve) => {
    process.stdout.write(question);
    const chars: string[] = [];

    // setRawMode(true) BEFORE registering data listener — guarantees no
    // keystroke is delivered to the terminal echo buffer before raw mode
    // is active. This ordering is the S1 invariant under test.
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    const onData = (ch: string): void => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004' /* Ctrl-D */) {
        // Sequence: restore terminal state BEFORE resolving (teardown before
        // setup in the source ordering).
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(chars.join('').trim());
      } else if (ch === '\u0003' /* Ctrl-C */) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write('\n');
        process.exit(1);
      } else if (ch === '\u007f' /* Backspace */) {
        chars.pop();
      } else {
        chars.push(ch);
      }
    };

    process.stdin.on('data', onData);
  });
}
