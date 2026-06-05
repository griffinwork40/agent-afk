/**
 * Test-only helpers for working with git-args arrays in unit tests.
 *
 * Production code in `git.ts` prepends a fixed `-c <key>=<value>` hardening
 * prefix to every clone / fetch / checkout invocation. Test fakes that
 * dispatch on the subcommand (`args[0] === 'clone'`) therefore need to skip
 * past the `-c` pairs before reading the subcommand name. This file
 * centralises that logic so every test file doesn't reinvent it.
 *
 * NOT exported from the package's public surface; tests import directly.
 *
 * @module agent/plugins/git-test-helpers
 */

/**
 * Return the first non-`-c` token in `args`, i.e. the actual git subcommand
 * (`clone`, `fetch`, `checkout`, `tag`, `rev-parse`, `symbolic-ref`). Returns
 * `undefined` if no subcommand is present (e.g. `['-c', 'x=y']` alone).
 *
 * `-c` takes a positional value, so when we see `-c` we skip the next token.
 */
export function subcommandOf(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c') {
      i++; // skip the `-c` value
      continue;
    }
    return args[i];
  }
  return undefined;
}

/**
 * Assert that `args` contains the pair `['-c', value]` as adjacent elements.
 *
 * Used by hardening tests to verify the suppression flags are present
 * without depending on their exact position.
 */
export function hasFlagPair(args: readonly string[], value: string): boolean {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-c' && args[i + 1] === value) return true;
  }
  return false;
}
