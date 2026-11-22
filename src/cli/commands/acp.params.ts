/**
 * Validation of ACP session-setup params (profile §2, §8): cwd shape
 * and conversion of the wire stdio MCP array into AFK's name-keyed config.
 * A4 may reuse {@link convertMcpServers}.
 *
 * @module cli/commands/acp.params
 */

import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { McpServerConfig } from '../../agent/mcp/types.js';
import type { McpServerStdio } from './acp.wire.js';

/** Thrown for any invalid-params condition; `detail` is for stderr only. */
export class AcpInvalidParams extends Error {
  constructor(readonly detail: string) {
    super('Invalid params');
  }
}

/**
 * Invariant: cwd must be an absolute, existing directory; it is canonicalised
 * once (symlinks resolved). D14: it need not be under the server's launch
 * directory; the approval policy, not containment, protects the session.
 */
export function validateCwd(raw: unknown): string {
  if (typeof raw !== 'string' || !path.isAbsolute(raw)) throw new AcpInvalidParams('cwd must be absolute');
  let resolved: string;
  try {
    // .native: on Windows the JS realpath keeps 8.3 short names (RUNNER~1);
    // the native one returns the long form the tool handlers' own containment
    // check canonicalises to (path-policy.roots realpathSafe), so policy and
    // enforcement see one spelling of the session directory.
    resolved = realpathSync.native(raw);
    if (!statSync(resolved).isDirectory()) throw new AcpInvalidParams(`cwd is not a directory: ${raw}`);
  } catch (err) {
    if (err instanceof AcpInvalidParams) throw err;
    throw new AcpInvalidParams(`cwd does not exist: ${raw}`);
  }
  return resolved;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

function parseEntry(raw: unknown): McpServerStdio {
  if (typeof raw !== 'object' || raw === null) throw new AcpInvalidParams('mcp entry is not an object');
  const o = raw as Record<string, unknown>;
  if ('type' in o) throw new AcpInvalidParams(`unsupported MCP transport: ${String(o['type'])}`);
  const { name, command, args, env } = o;
  if (typeof name !== 'string' || name === '') throw new AcpInvalidParams('mcp name must be a non-empty string');
  if (typeof command !== 'string' || !path.isAbsolute(command)) {
    throw new AcpInvalidParams('mcp command must be an absolute path');
  }
  if (!isStringArray(args)) throw new AcpInvalidParams('mcp args must be a string array');
  if (!Array.isArray(env)) throw new AcpInvalidParams('mcp env must be an array');
  const pairs = env.map((e: unknown) => {
    const p = e as Record<string, unknown> | null;
    if (typeof p !== 'object' || p === null || typeof p['name'] !== 'string' || typeof p['value'] !== 'string') {
      throw new AcpInvalidParams('mcp env entries need string name and value');
    }
    return { name: p['name'], value: p['value'] };
  });
  return { name, command, args, env: pairs };
}

/** Validate the wire `mcpServers` array; duplicates and non-stdio entries are invalid. */
export function parseMcpServers(raw: unknown): McpServerStdio[] {
  if (!Array.isArray(raw)) throw new AcpInvalidParams('mcpServers must be an array');
  return raw.map(parseEntry);
}

/** Convert validated stdio entries to AFK's name-keyed config without changing values. */
export function convertMcpServers(servers: readonly McpServerStdio[]): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const s of servers) {
    if (Object.prototype.hasOwnProperty.call(out, s.name)) throw new AcpInvalidParams(`duplicate MCP server: ${s.name}`);
    const env: Record<string, string> = {};
    for (const e of s.env) {
      if (Object.prototype.hasOwnProperty.call(env, e.name)) throw new AcpInvalidParams(`duplicate env name: ${e.name}`);
      env[e.name] = e.value;
    }
    out[s.name] = { type: 'stdio', command: s.command, args: [...s.args], env };
  }
  return out;
}

export interface SessionSetup {
  cwd: string;
  wireMcp: McpServerStdio[];
  mcpServers: Record<string, McpServerConfig>;
  sessionId?: string;
  /** Client-supplied system prompt to append to the session prompt (session/new only). */
  systemPrompt?: string;
}

/**
 * Parse params for session/new (`needsId` false), session/load and
 * session/resume (`needsId` true). Resume may omit mcpServers (treated as []).
 */
export function parseSessionSetup(
  params: unknown, mode: 'new' | 'load' | 'resume',
): SessionSetup {
  if (typeof params !== 'object' || params === null) throw new AcpInvalidParams('params must be an object');
  const p = params as Record<string, unknown>;
  const dirs = p['additionalDirectories'];
  if (dirs !== undefined && dirs !== null && (!Array.isArray(dirs) || dirs.length > 0)) {
    throw new AcpInvalidParams('additionalDirectories is not supported');
  }
  let systemPrompt: string | undefined;
  if (p['systemPrompt'] !== undefined && p['systemPrompt'] !== null) {
    if (typeof p['systemPrompt'] !== 'string') throw new AcpInvalidParams('systemPrompt must be a string');
    if (mode !== 'new') throw new AcpInvalidParams('systemPrompt is only supported on session/new');
    if (p['systemPrompt'].trim().length > 0) systemPrompt = p['systemPrompt'];
  }
  const rawMcp = mode === 'resume' && p['mcpServers'] === undefined ? [] : p['mcpServers'];
  const wireMcp = parseMcpServers(rawMcp);
  const mcpServers = convertMcpServers(wireMcp);
  const cwd = validateCwd(p['cwd']);
  if (mode === 'new') return { cwd, wireMcp, mcpServers, ...(systemPrompt !== undefined ? { systemPrompt } : {}) };
  const sessionId = p['sessionId'];
  if (typeof sessionId !== 'string' || sessionId === '') throw new AcpInvalidParams('sessionId required');
  /* invariant: systemPrompt is always undefined here — mode guard above */
  return { cwd, wireMcp, mcpServers, sessionId };
}
