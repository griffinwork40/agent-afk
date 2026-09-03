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
 * Layer-aware variants (`expandEnvStringForLayer`, `expandEnvRecordForLayer`)
 * add defense-in-depth for project-local servers (issue #578):
 *   - Secret-pattern placeholders (`${AWS_SECRET}`, `${OPENAI_API_KEY}`, …)
 *     are blocked and emitted as warnings unless the server's `allowSecretEnv`
 *     list explicitly permits them.
 *   - User-global / plugin / CLI servers bypass the restriction entirely.
 *
 * Used by the connection path in `client.ts` immediately before constructing
 * the transport — keeps secret values out of the in-memory `McpServerConfig`
 * that we surface to `/mcp` and persist to state files.
 *
 * @module agent/mcp/env
 */

import { checkSecretExpansion, type McpServerLayer } from './env-containment.js';

const PLACEHOLDER = /\$(\$)?\{([A-Z_][A-Z0-9_]*)\}/gi;

export interface EnvExpansionResult<T> {
  value: T;
  missing: string[];
  /** Var names whose expansion was blocked by the secret-pattern gate. */
  blocked: string[];
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
): Omit<EnvExpansionResult<string>, 'blocked'> {
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
): Omit<EnvExpansionResult<Record<string, string>>, 'blocked'> {
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

// ── Layer-aware variants (issue #578) ───────────────────────────────────────

/**
 * Layer-aware context for secret-guarded expansion.
 */
export interface EnvExpansionContext {
  /** Which config layer the server originates from. */
  layer: McpServerLayer;
  /** Server name for warning messages. */
  serverName: string;
  /** Variables the server config explicitly permits expanding (project layer only). */
  allowSecretEnv?: readonly string[];
}

/**
 * Layer-aware variant of `expandEnvString`. For project-layer servers, any
 * `${VAR}` whose name matches a known-secret pattern is blocked (expansion is
 * replaced with the empty string) and recorded in `blocked`. A caller-supplied
 * `warn` callback receives the human-readable warning so the call site can
 * route it via `console.warn` or the structured logger.
 */
export function expandEnvStringForLayer(
  input: string,
  ctx: EnvExpansionContext,
  source: NodeJS.ProcessEnv = process.env,
  warn: (msg: string) => void = console.warn,
): EnvExpansionResult<string> {
  const missing: string[] = [];
  const blocked: string[] = [];

  const expanded = input.replace(PLACEHOLDER, (_match, escape: string | undefined, name: string) => {
    if (escape === '$') {
      return `\${${name}}`;
    }

    // Secret-gate check (project layer only).
    const check = checkSecretExpansion(name, ctx.layer, ctx.serverName, ctx.allowSecretEnv);
    if (!check.allowed) {
      if (check.warning) warn(check.warning);
      blocked.push(name);
      return '';
    }

    const value = source[name];
    if (value === undefined || value === '') {
      missing.push(name);
      return '';
    }
    return value;
  });

  return { value: expanded, missing, blocked };
}

/**
 * Layer-aware variant of `expandEnvRecord`. Aggregates `missing` and
 * `blocked` across all values, de-duplicated.
 */
export function expandEnvRecordForLayer(
  input: Record<string, string> | undefined,
  ctx: EnvExpansionContext,
  source: NodeJS.ProcessEnv = process.env,
  warn: (msg: string) => void = console.warn,
): EnvExpansionResult<Record<string, string>> {
  if (input === undefined) return { value: {}, missing: [], blocked: [] };
  const out: Record<string, string> = {};
  const missingSet = new Set<string>();
  const blockedSet = new Set<string>();

  for (const [key, raw] of Object.entries(input)) {
    const { value, missing, blocked } = expandEnvStringForLayer(raw, ctx, source, warn);
    out[key] = value;
    for (const name of missing) missingSet.add(name);
    for (const name of blocked) blockedSet.add(name);
  }

  return { value: out, missing: [...missingSet], blocked: [...blockedSet] };
}
