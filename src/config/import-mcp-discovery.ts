import { readFileSync } from 'fs';
import type { DetectedMcpServer, McpConfigFormat } from './import-sources.js';

/**
 * Read MCP server names + command summaries from a config file. Supports the
 * JSON `mcpServers` object (Claude Code) and the TOML `[mcp_servers.<id>]`
 * table format (Codex), where the server name is the table key. Best-effort:
 * a parse failure returns [].
 */
export function readMcpServers(path: string, format: McpConfigFormat): DetectedMcpServer[] {
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  return format === 'json' ? readMcpServersJson(content) : readMcpServersToml(content);
}

function readMcpServersJson(content: string): DetectedMcpServer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object') return [];
  const servers = (parsed as Record<string, unknown>)['mcpServers'];
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) return [];
  const out: DetectedMcpServer[] = [];
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    out.push({ name, command: summarizeServerCommand(raw) });
  }
  return out;
}

/**
 * Parse the `[mcp_servers.<id>]` table format from a Codex `config.toml`.
 * The server name is the table key (e.g. `[mcp_servers.github]` → name "github").
 * Fields read per block: `command` (string), `args` (inline array of strings),
 * `url` (string). Command summary precedence: url → command+args joined → '(no command)'.
 * Deliberately narrow and dependency-free — ignores everything outside mcp_servers tables.
 */
function readMcpServersToml(content: string): DetectedMcpServer[] {
  const out: DetectedMcpServer[] = [];
  const lines = content.split(/\r?\n/);
  let inBlock = false;
  let name: string | null = null;
  let command: string | null = null;
  let url: string | null = null;
  let args: string[] = [];

  const flush = (): void => {
    if (inBlock && name) {
      let summary: string;
      if (url !== null) {
        summary = url;
      } else if (command !== null) {
        summary = args.length > 0 ? [command, ...args].join(' ') : command;
      } else {
        summary = '(no command)';
      }
      out.push({ name, command: summary });
    }
    name = null;
    command = null;
    url = null;
    args = [];
  };

  const MCP_SERVER_HEADER = /^\[mcp_servers\.([^\]]+)\]\s*$/;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const headerMatch = MCP_SERVER_HEADER.exec(line);
    if (headerMatch) {
      flush();
      inBlock = true;
      name = headerMatch[1] ?? null;
      continue;
    }
    if (line.startsWith('[')) {
      flush();
      inBlock = false;
      continue;
    }
    if (!inBlock) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const rawValue = line.slice(eq + 1).trim();

    if (key === 'command') {
      command = stripTomlString(stripInlineComment(rawValue));
    } else if (key === 'url') {
      url = stripTomlString(stripInlineComment(rawValue));
    } else if (key === 'args') {
      args = parseTomlInlineStringArray(rawValue);
    }
  }
  flush();
  return out;
}

/** Strip a trailing inline TOML comment (`# ...`) from a scalar value line.
 *  Only strips when the value does not start with a quote (quoted strings may
 *  contain # legitimately). Best-effort heuristic for narrow use. */
function stripInlineComment(value: string): string {
  if (value.startsWith('"') || value.startsWith("'")) return value;
  const idx = value.indexOf(' #');
  return idx === -1 ? value : value.slice(0, idx).trimEnd();
}

/** Parse a TOML inline string array: `["-y", "pkg"]` → `['-y', 'pkg']`.
 *  Best-effort: strips surrounding `[ ]`, splits on commas, stripTomlString each.
 *  Returns [] on any parse failure. */
function parseTomlInlineStringArray(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[')) return [];
  const inner = trimmed.slice(1, trimmed.lastIndexOf(']'));
  if (!inner.trim()) return [];
  try {
    return inner
      .split(',')
      .map((s) => stripTomlString(s.trim()))
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

function stripTomlString(value: string): string {
  // Matched pair: strip surrounding quotes.
  const m = value.match(/^"([^"]*)"$/) ?? value.match(/^'([^']*)'$/);
  if (m && m[1] !== undefined) return m[1];
  // Unmatched leading/trailing quote (e.g. truncated value) — strip it.
  if (value.startsWith('"') || value.startsWith("'")) return value.slice(1);
  if (value.endsWith('"') || value.endsWith("'")) return value.slice(0, -1);
  return value;
}

function summarizeServerCommand(raw: unknown): string {
  if (raw === null || typeof raw !== 'object') return '(invalid)';
  const obj = raw as Record<string, unknown>;
  if (typeof obj['url'] === 'string') return obj['url'];
  if (typeof obj['command'] === 'string') {
    const args = Array.isArray(obj['args'])
      ? (obj['args'] as unknown[]).filter((a): a is string => typeof a === 'string')
      : [];
    return [obj['command'], ...args].join(' ');
  }
  return '(no command)';
}
