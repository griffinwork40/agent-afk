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
 * Levenshtein distance between two strings — used only for subcommand
 * suggestions.  Kept local so the guard file has no runtime import from
 * slash/registry (which carries heavy side-effects on first import).
 */
function editDistance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i++) dp[i]![0] = i;
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }
  return dp[a.length]![b.length]!;
}

/**
 * Return the closest registered CLI subcommand name within `maxDistance`, or
 * undefined when nothing is close enough.  Searches canonical names only
 * (no aliases) to keep the candidate pool small and well-typed.
 *
 * `maxDistance = 2` is deliberately tighter than the slash-command registry's
 * default of 3 because CLI subcommand names are short (≤10 chars) and a
 * distance-3 threshold produces too many false positives against ordinary
 * one-word prompts.
 */
export function suggestCliCommand(token: string, program: Command, maxDistance = 2): string | undefined {
  let best: { name: string; dist: number } | undefined;
  for (const cmd of program.commands) {
    const name = cmd.name();
    if (!name) continue;
    const d = editDistance(token, name);
    if (d <= maxDistance && (best === undefined || d < best.dist)) {
      best = { name, dist: d };
    }
  }
  return best?.name;
}

/**
 * Issue #710, mode 2 (bare unknown token, no flags):
 *
 * `afk skill` reaches the `interactive` action with `input = ['skill']` and
 * no unknown flag — so the mode-1 `unknownOption` monkey-patch never fires.
 * Commander happily dispatches `'skill'` as the first turn of a new REPL
 * session.  When that REPL session is a subagent that itself calls `afk
 * skill`, a forkbomb results (observed at 134 live processes on 2026-08-09).
 *
 * Fix: inside the action, before any side-effect, call this function.  It
 * errors immediately when `input` is a single bare word that:
 *   (a) passes `isUnrecognizedCommandToken`, AND
 *   (b) is within Levenshtein distance ≤ 2 of a registered subcommand name
 *       (tight enough to avoid false-positives on ordinary one-word prompts
 *       like `stats`, `log`, `plan`), OR
 *   (c) is NOT within distance ≤ 2 of ANY subcommand but is a single
 *       all-lowercase word with no spaces (heuristic: users rarely type a
 *       one-word all-lowercase prompt without punctuation or context — but
 *       they do type mistyped subcommands that way). To avoid overfiring on
 *       legitimate single-word prompts the latter arm additionally requires
 *       that the word appears in the registered-subcommand candidate set when
 *       spelling-corrected — i.e. it must have a near-miss. Words with no
 *       near-miss at all (distance > 2) are left alone so `afk help` or
 *       `afk summarize` still open the REPL normally.
 *
 * The multi-word path (`afk "explain this"`, `afk do a thing`) is never
 * affected: `input.length > 1` or the single token contains whitespace.
 */
export function checkBareUnknownCommand(
  input: string[],
  program: Command,
): { isUnknown: true; token: string; suggestion: string | undefined } | { isUnknown: false } {
  // Only intercept the single-bare-word shape: afk <word>
  if (input.length !== 1) return { isUnknown: false };
  const token = input[0]!;
  // Multi-word single-string (quoted prompt) and slash-commands pass through.
  if (token.includes(' ') || token.startsWith('/') || token.startsWith('-')) {
    return { isUnknown: false };
  }
  if (!isUnrecognizedCommandToken(token, program)) return { isUnknown: false };
  const suggestion = suggestCliCommand(token, program);
  // Only error when there IS a near-miss — otherwise the word is probably a
  // legitimate one-word prompt and we leave it alone.
  if (suggestion === undefined) return { isUnknown: false };
  return { isUnknown: true, token, suggestion };
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
