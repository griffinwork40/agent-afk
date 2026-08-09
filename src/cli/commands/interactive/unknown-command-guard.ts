import type { Command } from 'commander';

/**
 * True when `token` looks like a mistyped subcommand rather than the
 * legitimate first token of a bare-prompt or slash-command REPL launch.
 *
 * Guards, in order:
 *   - `undefined`/empty: no positional token at all (e.g. `afk --badflag`
 *     with nothing before the flag) — nothing to name.
 *   - Leading `/`: a documented, load-bearing slash-command launch path
 *     (`afk /review`) — never reinterpret as a bad command name.
 *   - Leading `-`: the token IS the (mis-set) unknown flag itself surfacing
 *     as `args[0]` (e.g. `afk --badflag`) — the original flag-blaming
 *     message is correct there.
 *   - Already a registered command/alias name: unreachable in practice
 *     (commander dispatches a matched name to that command's own
 *     `_parseCommand` before the default command ever sees it) but kept as
 *     a defensive check so this function's contract stands alone.
 */
export function isUnrecognizedCommandToken(
  token: string | undefined,
  program: Command,
): token is string {
  if (token === undefined || token.length === 0) return false;
  if (token.startsWith('/') || token.startsWith('-')) return false;
  return !program.commands.some((cmd) => cmd.name() === token || cmd.aliases().includes(token));
}

/**
 * Issue #710, mode 1: a mistyped subcommand (`afk config_set env X --unset`)
 * blames its trailing flag (`error: unknown option '--unset'`) instead of
 * naming the unrecognized command. Root cause: `interactive.ts` registers
 * `interactive` as commander's default command with `.argument('[input...]')`,
 * so commander's `_parseCommand` dispatches ANY unrecognized leading token to
 * `interactive` before `unknownCommand()` ever gets a chance to fire — the
 * default command's own `unknownOption()` fires first instead, blaming
 * whatever flag happens to be unknown.
 *
 * Fix: monkey-patch `unknownOption` on the specific dispatched Command
 * instance (`interactiveCmd`) so it names the real culprit — the
 * unrecognized leading token, available as `this.args[0]` inside
 * `unknownOption()` — before falling back to the stock flag-blaming message.
 * `configureOutput` was considered and rejected: it only observes the
 * already-formatted error string, not the original argv token, so it cannot
 * distinguish "mistyped command" from "genuinely bad flag on a valid
 * command/bare prompt".
 *
 * Deliberately NOT fixed here (see issue #710 mode 2): a bare unknown token
 * with no flags at all (`afk zzzbogus`) still boots a full interactive
 * session instead of erroring, because commander never calls
 * `unknownOption`/`unknownCommand` in that path at all — there's no unknown
 * flag to intercept. Closing that gap would require a "did you mean"
 * near-miss heuristic, which was measured (Levenshtein ≤3 against registered
 * command names) to false-positive on ordinary one-word prompts (`stats`,
 * `grace`, `confirm`, `log`, `plan`, `commit`, `where`, …) at a 14–16/20 rate,
 * even tightened to ≤2 with a canonical-names-only pool it was still 8/20 —
 * hard-erroring on a legitimate prompt is a worse regression than the bug
 * being fixed, so that half is intentionally out of scope.
 */
export function installUnknownCommandGuard(interactiveCmd: Command, program: Command): void {
  const patchTarget = interactiveCmd as Command & { unknownOption(flag: string): void };
  const originalUnknownOption = patchTarget.unknownOption.bind(patchTarget);
  patchTarget.unknownOption = function guardedUnknownOption(flag: string): void {
    const firstToken = patchTarget.args[0];
    if (isUnrecognizedCommandToken(firstToken, program)) {
      patchTarget.error(`error: unknown command '${firstToken}'`, {
        code: 'commander.unknownCommand',
      });
      return;
    }
    originalUnknownOption(flag);
  };
}
