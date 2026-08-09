/**
 * Argument templating for SKILL.md bodies.
 *
 * Extracted from `load-mode.ts` when positional support landed: templating is
 * its own concern (a tokenizer plus a substitution grammar) and belongs beside
 * the execution modes rather than inside one of them.
 *
 * Consumed by every path that renders a body WITHOUT a forked sub-agent's user
 * message being the only carrier of the args — both plugin paths, the registry
 * load path, and the user/project disk fork path.
 *
 * @module agent/tools/skill-executor/arg-substitution
 */

/**
 * Split a raw argument string into shell-style tokens.
 *
 * Contract:
 * - Whitespace separates tokens; runs of whitespace collapse.
 * - Single and double quotes group a token and are stripped from the result,
 *   so `/cmd "hello world" x` yields ['hello world', 'x'] rather than
 *   ['"hello', 'world"', 'x']. Quoting is the only reason this is not a
 *   `split(/\s+/)` — a positional that silently splits a quoted phrase is
 *   worse than no positional support at all.
 * - An empty quoted string produces an empty token, so `${1}` in `/cmd "" b`
 *   expands to '' and `${2}` to 'b' — position is preserved.
 * - An UNTERMINATED quote is tolerated: the remainder becomes the final token
 *   rather than throwing. This runs while rendering a prompt, where a hard
 *   failure would take down an otherwise-working skill over a typo.
 * - No escape processing inside tokens. Backslash handling belongs to the
 *   substitution grammar (see `substituteSkillArgs`), not the tokenizer, and
 *   adding shell-escape semantics here would surprise authors who wrote a
 *   Windows path.
 */
export function tokenizeArgs(args: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  // Distinguishes "no token in progress" from "token in progress that is
  // currently empty" — without it, `""` would vanish instead of yielding ''.
  let open = false;

  for (const ch of args) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      open = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (open) {
        tokens.push(current);
        current = '';
        open = false;
      }
      continue;
    }
    current += ch;
    open = true;
  }
  if (open) tokens.push(current);
  return tokens;
}

/**
 * Substitute argument placeholders in a SKILL.md body.
 *
 * Contract:
 * - `$ARGUMENTS` and `$ARGUMENT` both expand to the full raw args string,
 *   unsplit and unquoted — the long-standing behaviour, preserved exactly.
 * - `${1}`, `${2}`, … `${N}` expand to shell-style positional tokens,
 *   1-indexed (`${1}` is the first argument). Braces are required so existing
 *   currency and shell snippets such as `$1.00` and `awk '{print $1}'` remain
 *   literal.
 * - A positional with no corresponding argument is left VERBATIM rather than
 *   emptied. An author writing `${3}` in a body invoked with two args almost
 *   certainly has a bug, and a literal `${3}` in the rendered prompt is a
 *   legible symptom; silently blanking it hides the mistake from both the
 *   author and the model.
 * - A placeholder may be escaped with a single leading backslash — `\${1}`
 *   and `\$ARGUMENTS` render as literal `${1}` / `$ARGUMENTS`. Needed by any
 *   body that documents this very syntax.
 * - Substitution is SINGLE-PASS over one combined pattern. This is the
 *   load-bearing property: two sequential `.replace()` calls would let the
 *   second scan text inserted by the first, so args containing `${1}` would be
 *   re-expanded. One pass makes inserted text inert by construction.
 * - The replacer is a FUNCTION, not a replacement string, so `$$`, `$&`,
 *   '$`', `$'` and `$n` inside args are inserted verbatim instead of being
 *   read as `String.prototype.replace` special patterns.
 * - Bodies containing no placeholder are returned unchanged.
 *
 * Not applied to `executeForkedRegistrySkill`: that path hands args to the
 * child as its user message, and built-in `system.md` bodies do not reference
 * placeholders by convention.
 */
export function substituteSkillArgs(body: string, args: string | undefined): string {
  const raw = args ?? '';
  // Tokenized lazily — bodies with only `$ARGUMENTS` (the common case) never
  // pay for the scan.
  let tokens: string[] | undefined;

  return body.replace(
    /(\\?)\$(ARGUMENTS?\b|\{(\d+)\})/g,
    (match, escape: string, name: string, digits: string | undefined) => {
      // An escaped placeholder renders literally, minus the backslash.
      if (escape === '\\') return match.slice(1);
      if (name === 'ARGUMENT' || name === 'ARGUMENTS') return raw;
      const index = Number(digits);
      // `${0}` is not a positional; leave it alone rather than inventing a meaning.
      if (index < 1) return match;
      tokens ??= tokenizeArgs(raw);
      const token = tokens[index - 1];
      return token ?? match;
    },
  );
}
