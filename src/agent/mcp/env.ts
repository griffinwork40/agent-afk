/**
 * `${VAR}` expansion for MCP server config.
 *
 * The expander deliberately:
 *   - Resolves only from `process.env` — never invokes a shell, never
 *     evaluates expressions. The input is user-config-trusted but we still
 *     want zero command-injection surface.
 *   - Treats unset variables as the empty string and reports them via the
 *     `missing` array on the result so the caller can warn (or fail when
 *     `alwaysLoad: true`).
 *   - Leaves escaped placeholders `$${VAR}` literal (consumes one `$`).
 *
 * Used by the connection path in `client.ts` immediately before constructing
 * the transport — keeps secret values out of the in-memory `McpServerConfig`
 * that we surface to `/mcp` and persist to state files.
 *
 * @module agent/mcp/env
 */

const PLACEHOLDER = /\$(\$)?\{([A-Z_][A-Z0-9_]*)\}/gi;

export interface EnvExpansionResult<T> {
  value: T;
  missing: string[];
}

/**
 * Expand `${VAR}` placeholders in a single string against `process.env`
 * (or a caller-supplied source for tests). `$${VAR}` escapes to literal
 * `${VAR}`. Returns the expanded string and a list of variable names that
 * were referenced but unset.
 */
export function expandEnvString(
  input: string,
  source: NodeJS.ProcessEnv = process.env,
): EnvExpansionResult<string> {
  const missing: string[] = [];
  const expanded = input.replace(PLACEHOLDER, (_match, escape: string | undefined, name: string) => {
    if (escape === '$') {
      // `$${VAR}` → keep one `$` and the literal `${VAR}`.
      return `\${${name}}`;
    }
    const value = source[name];
    if (value === undefined || value === '') {
      missing.push(name);
      return '';
    }
    return value;
  });
  return { value: expanded, missing };
}

/**
 * Expand every value in a `Record<string, string>` map. Keys are left
 * untouched. Aggregates `missing` across all values, de-duplicated.
 */
export function expandEnvRecord(
  input: Record<string, string> | undefined,
  source: NodeJS.ProcessEnv = process.env,
): EnvExpansionResult<Record<string, string>> {
  if (input === undefined) return { value: {}, missing: [] };
  const out: Record<string, string> = {};
  const missingSet = new Set<string>();
  for (const [key, raw] of Object.entries(input)) {
    const { value, missing } = expandEnvString(raw, source);
    out[key] = value;
    for (const name of missing) missingSet.add(name);
  }
  return { value: out, missing: [...missingSet] };
}
