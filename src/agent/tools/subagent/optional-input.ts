/**
 * Blank-tolerant readers for OPTIONAL Agent-tool input fields.
 *
 * Contract: for an optional field, "supplied blank" and "not supplied" are the
 * same request — `undefined`, `null`, and whitespace-only strings all read as
 * absent. Model serializers (OpenAI-family ones especially) routinely pad an
 * arguments object with `""`/`null` for optionals they do not want; a parser
 * that only tests `!== undefined` reads that padding as caller intent and
 * rejects a request nobody made.
 *
 * This is NOT the "silent coercion" this parser deliberately refuses for
 * `mode`. A typo like `mode:"back"` carries real-but-wrong intent, and
 * defaulting it would hide a mistake. A blank carries no intent at all, so
 * there is nothing to hide — collapsing it restores the omitted-field path.
 *
 * Load-bearing case: `cwd` and `isolation` are mutually exclusive, so a padded
 * `cwd:''` next to `isolation:'worktree'` produced a self-contradictory error
 * PAIR — "cwd and isolation are mutually exclusive", then "cwd must be a
 * non-empty string" — which reads as "cwd is required, and requiring it forbids
 * isolation". Models resolved that by dropping isolation and silently degrading
 * to an unisolated dispatch, i.e. an input-normalization gap surfaced as a
 * capability loss.
 *
 * Scope: opt-in per field, NEVER dispatcher-wide. `write_file.content`,
 * `edit_file.new_string`, and `browser_act.value` all take `''` as a real
 * payload (empty file, deletion, clear-the-input), so blank must stay
 * meaningful there. Array ENTRIES are out of scope for the same reason:
 * silently dropping a blank entry from `readRoots`/`writeRoots` would quietly
 * shrink a grant, so those keep rejecting loudly.
 *
 * @module agent/tools/subagent/optional-input
 */

/** True when a value carries no caller intent: absent, null, or whitespace-only. */
export function isBlankInput(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === 'string' && value.trim().length === 0;
}

/**
 * First non-blank value among `keys`, or `undefined` when every one is blank.
 *
 * The multi-key form serves alias pairs (`agent_type` / `subagent_type`): a
 * padded `agent_type:''` no longer shadows a real `subagent_type`, which plain
 * `??` allowed because `'' !== undefined`.
 */
export function readOptional(
  input: Record<string, unknown>,
  ...keys: readonly string[]
): unknown {
  for (const key of keys) {
    const value = input[key];
    if (!isBlankInput(value)) return value;
  }
  return undefined;
}

/**
 * {@link readOptional} plus a string type check.
 *
 * Blank → `undefined`; wrong type → throw. `label` names the field in the error
 * (defaults to `key`) so an alias pair can report the canonical name.
 * Non-blank values are returned verbatim — never trimmed, because trimming a
 * path or model id would silently alter a value the caller did supply.
 */
export function readOptionalString(
  input: Record<string, unknown>,
  key: string,
  label: string = key,
): string | undefined {
  const value = readOptional(input, key);
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Agent tool ${label} must be a string, got: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * {@link readOptionalString} for alias pairs: reads `keys` in precedence order
 * and reports errors under `label`.
 */
export function readOptionalAliasString(
  input: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): string | undefined {
  const value = readOptional(input, ...keys);
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Agent tool ${label} must be a string, got: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * {@link readOptional} plus a number type check.
 *
 * Blank → `undefined` (caller applies its own default); wrong type → throw.
 * A numeric string is deliberately NOT coerced: `max_turns:"10"` is a schema
 * violation with real intent behind it, and quietly accepting it would mask a
 * caller bug the loud error surfaces in one round.
 */
export function readOptionalNumber(
  input: Record<string, unknown>,
  key: string,
  label: string = key,
): number | undefined {
  const value = readOptional(input, key);
  if (value === undefined) return undefined;
  if (typeof value !== 'number') {
    throw new Error(`Agent tool ${label} must be a number, got: ${JSON.stringify(value)}`);
  }
  return value;
}
