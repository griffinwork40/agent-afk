/**
 * Parser for Claude Code-format subagent markdown files.
 *
 * Format: YAML frontmatter (name, description, tools, disallowedTools, model,
 * maxTurns, …) followed by a markdown body that becomes the child session's
 * system prompt. Only `name` and `description` are required. Unknown and
 * long-tail keys are tolerated (recorded, never fatal) so files written for
 * Claude Code parse without modification.
 *
 * Deliberately hand-rolled line parser in the same style as
 * `plugins/tool-injector.ts` — no YAML dependency, tolerant of the narrow
 * shapes real agent files use.
 *
 * @module agent/agents/parser
 */

import type { AgentDefinition } from '../types/sdk-types.js';
import { parseToolsField } from '../plugins/tool-injector.js';

/** Parse outcome for a single agent markdown file. */
export interface ParsedAgentFile {
  name: string;
  definition: AgentDefinition;
  bashReadOnly?: boolean;
  ignoredKeys?: string[];
}

/**
 * Claude Code long-tail frontmatter fields AFK recognizes but does not honor
 * yet. Parsed tolerantly (recorded in `ignoredKeys`) rather than warned as
 * unknown, so a file using them still loads with correct core semantics.
 */
const RECOGNIZED_UNSUPPORTED_KEYS: ReadonlySet<string> = new Set([
  'permissionmode',
  'permission-mode',
  'skills',
  'mcpservers',
  'mcp-servers',
  'hooks',
  'memory',
  'background',
  'effort',
  'isolation',
  'color',
  'initialprompt',
  'initial-prompt',
]);

/** Strip one layer of surrounding single/double quotes. */
function stripQuotes(value: string): string {
  const t = value.trim();
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
    (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
  ) {
    return t.slice(1, -1).trim();
  }
  return t;
}

/**
 * Read a scalar frontmatter value that may continue on following indented
 * lines (YAML folded `>`/`>-` style or bare continuation). Returns the joined
 * value and the number of continuation lines consumed.
 */
function readScalar(
  inline: string,
  lines: string[],
  startIdx: number,
): { value: string; consumed: number } {
  let value = stripQuotes(inline);
  const isFoldMarker = value === '>' || value === '>-' || value === '|' || value === '|-';
  if (isFoldMarker) value = '';
  let consumed = 0;
  // Continuation lines: indented, not a new `key:` at column 0, not a list item.
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) break;
    if (!/^\s+\S/.test(line)) break; // requires leading indentation
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) break; // sequences belong to list fields
    // A new top-level key never matches (no leading indent), so any indented
    // text is continuation.
    value = value.length > 0 ? `${value} ${trimmed}` : trimmed;
    consumed++;
  }
  return { value, consumed };
}

/**
 * Parse a Claude Code subagent markdown document.
 *
 * @param content Raw file content.
 * @param warn Sink for non-fatal diagnostics (missing fields, unknown keys).
 * @returns Parsed file, or `undefined` when the document has no valid
 *   frontmatter or misses a required field (`name`, `description`) or has an
 *   empty body (no system prompt to run).
 */
export function parseAgentMarkdown(
  content: string,
  warn: (message: string) => void = () => {},
): ParsedAgentFile | undefined {
  if (!content.startsWith('---')) {
    warn('missing frontmatter (file must start with ---)');
    return undefined;
  }
  const afterOpen = content.slice(3);
  const endIdx = afterOpen.indexOf('\n---');
  if (endIdx === -1) {
    warn('unterminated frontmatter (no closing ---)');
    return undefined;
  }
  const frontmatterText = afterOpen.slice(0, endIdx);
  // Body starts after the closing `---` line.
  const rest = afterOpen.slice(endIdx + 4);
  const body = rest.startsWith('\n') ? rest.slice(1) : rest;

  const lines = frontmatterText.split('\n');
  let name: string | undefined;
  let description: string | undefined;
  let model: string | undefined;
  let maxTurns: number | undefined;
  let maxToolUseIterations: number | undefined;
  let bashReadOnly: boolean | undefined;
  let tools: string[] | undefined;
  let disallowedTools: string[] | undefined;
  const ignoredKeys: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.trim().length === 0) continue;
    if (/^\s/.test(line)) continue; // continuation/sequence lines are consumed by their key
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const keyLower = key.toLowerCase();
    const inline = line.slice(colonIdx + 1);
    const remaining = lines.slice(i + 1);

    switch (keyLower) {
      case 'name': {
        name = stripQuotes(inline);
        break;
      }
      case 'description': {
        const { value, consumed } = readScalar(inline, lines, i + 1);
        description = value;
        i += consumed;
        break;
      }
      case 'tools':
      case 'allowed-tools': {
        // `allowed-tools` accepted as an alias (agentskills.io skills use it;
        // authors conflate the two formats). Space-separated values are also
        // tokenized for the same reason.
        tools = splitPossiblySpaceSeparated(parseToolsField(inline, remaining));
        break;
      }
      case 'disallowedtools':
      case 'disallowed-tools': {
        disallowedTools = splitPossiblySpaceSeparated(parseToolsField(inline, remaining));
        break;
      }
      case 'model': {
        const value = stripQuotes(inline);
        if (value.length > 0) model = value;
        break;
      }
      case 'maxturns':
      case 'max-turns': {
        const parsed = Number.parseInt(stripQuotes(inline), 10);
        if (Number.isFinite(parsed) && parsed > 0) maxTurns = parsed;
        else warn(`invalid ${key} value ${JSON.stringify(inline.trim())} — ignored`);
        break;
      }
      case 'maxtooluseiterations':
      case 'max-tool-use-iterations': {
        const parsed = Number.parseInt(stripQuotes(inline), 10);
        if (Number.isFinite(parsed) && parsed > 0) maxToolUseIterations = parsed;
        else warn(`invalid ${key} value ${JSON.stringify(inline.trim())} — ignored`);
        break;
      }
      case 'bash': {
        // AFK extension: `bash: read-only` gates the child's shell to
        // non-mutating commands (classifyBashCommand) when bash is granted.
        const value = stripQuotes(inline).toLowerCase();
        if (value === 'read-only' || value === 'readonly') bashReadOnly = true;
        else warn(`unrecognized bash value ${JSON.stringify(inline.trim())} — ignored`);
        break;
      }
      default: {
        if (RECOGNIZED_UNSUPPORTED_KEYS.has(keyLower)) {
          ignoredKeys.push(key);
        } else {
          warn(`unknown frontmatter key ${JSON.stringify(key)} — ignored`);
        }
        break;
      }
    }
  }

  if (name === undefined || name.length === 0) {
    warn('missing required frontmatter field "name"');
    return undefined;
  }
  if (description === undefined || description.length === 0) {
    warn(`agent ${JSON.stringify(name)}: missing required frontmatter field "description"`);
    return undefined;
  }
  const prompt = body.trim();
  if (prompt.length === 0) {
    warn(`agent ${JSON.stringify(name)}: empty body — an agent file's body is its system prompt`);
    return undefined;
  }

  const definition: AgentDefinition = {
    description,
    prompt,
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(disallowedTools !== undefined && disallowedTools.length > 0 ? { disallowedTools } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(maxToolUseIterations !== undefined ? { maxToolUseIterations } : {}),
  };

  return {
    name,
    definition,
    ...(bashReadOnly === true ? { bashReadOnly: true } : {}),
    ...(ignoredKeys.length > 0 ? { ignoredKeys } : {}),
  };
}

/**
 * Post-split tokens that may themselves be space-separated. agentskills.io's
 * `allowed-tools` is a space-separated string; Claude Code uses commas. After
 * `parseToolsField` handles commas/YAML lists, split any token that still
 * contains internal whitespace — EXCEPT parenthesized groups like
 * `Agent(worker, researcher)`, which stay intact for downstream paren
 * stripping.
 */
function splitPossiblySpaceSeparated(tokens: string[]): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    if (token.includes('(')) {
      out.push(token);
      continue;
    }
    for (const part of token.split(/\s+/)) {
      if (part.length > 0) out.push(part);
    }
  }
  return out;
}
