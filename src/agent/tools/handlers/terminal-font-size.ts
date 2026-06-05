/**
 * Handler for the `terminal_font_size` built-in tool.
 *
 * Reads and writes the `terminal.integrated.fontSize` key in VS Code / Cursor
 * settings.json files. Supports `get` and `set` actions with an optional
 * per-editor filter.
 *
 * Design notes:
 *   - Atomic writes: data is written to a `.tmp` sibling then `rename`d so the
 *     settings file is never left in a half-written state.
 *   - JSONC guard: if `JSON.parse` fails on an existing file (comments, trailing
 *     commas, etc.) the `set` action aborts rather than overwriting user content.
 *   - Factory pattern: `createTerminalFontSizeHandler({ discoverFn?, writeFn? })`
 *     accepts injection seams so tests can redirect discovery and file writes
 *     without module-level mocking.
 *
 * @module agent/tools/handlers/terminal-font-size
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ToolHandler } from '../types.js';

// ── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_FONT_SIZE = 16;
export const MIN_FONT_SIZE = 6;
export const MAX_FONT_SIZE = 60;

// ── Types ────────────────────────────────────────────────────────────────────

export interface EditorTarget {
  name: string;
  path: string;
}

export interface TerminalFontSizeHandlerOpts {
  discoverFn?: () => EditorTarget[];
  writeFn?: (path: string, data: string, encoding: BufferEncoding) => Promise<void>;
}

// ── Editor discovery ─────────────────────────────────────────────────────────

const HOME = homedir();

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(HOME, p.slice(2)) : p;
}

/**
 * Returns the list of `EditorTarget`s whose settings.json files exist on disk.
 * Checks macOS canonical paths; appends Linux paths when running on Linux.
 */
export function discoverEditors(): EditorTarget[] {
  const candidates: EditorTarget[] = [
    {
      name: 'Cursor',
      path: '~/Library/Application Support/Cursor/User/settings.json',
    },
    {
      name: 'VS Code',
      path: '~/Library/Application Support/Code/User/settings.json',
    },
    {
      name: 'VS Code Insiders',
      path: '~/Library/Application Support/Code - Insiders/User/settings.json',
    },
  ];

  if (process.platform === 'linux') {
    candidates.push(
      { name: 'VS Code', path: '~/.config/Code/User/settings.json' },
      { name: 'Cursor', path: '~/.config/Cursor/User/settings.json' },
    );
  }

  return candidates.filter((c) => existsSync(expandHome(c.path)));
}

// ── Editor name normalisation ─────────────────────────────────────────────────

function normalizeEditorName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '');
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a `terminal_font_size` tool handler.
 *
 * @param opts - Optional injection seams for testing.
 *   - `discoverFn` — replaces the default `discoverEditors()` call
 *   - `writeFn`    — replaces `writeFile` from `node:fs/promises`; receives
 *                    the temp-file path, JSON string, and `'utf-8'`
 */
export function createTerminalFontSizeHandler(
  opts: TerminalFontSizeHandlerOpts = {},
): ToolHandler {
  const discover = opts.discoverFn ?? discoverEditors;
  const writeFn = opts.writeFn ?? writeFile;

  return async (input, _signal) => {
    // ── Input validation ────────────────────────────────────────────────────

    if (!input || typeof input !== 'object') {
      return { content: 'Invalid input: expected object', isError: true };
    }

    const obj = input as Record<string, unknown>;

    // Validate action
    const action = obj['action'];
    if (action !== 'get' && action !== 'set') {
      return {
        content:
          'Invalid action. Use "action": "get" to read current font sizes, or ' +
          '"action": "set" with "size": <number> to update them.',
        isError: true,
      };
    }

    // Validate size for set action
    let size: number | undefined;
    if (action === 'set') {
      if (typeof obj['size'] !== 'number') {
        return {
          content:
            `Invalid input: "size" must be a number between ${MIN_FONT_SIZE} and ${MAX_FONT_SIZE}.`,
          isError: true,
        };
      }
      size = obj['size'] as number;
      if (size < MIN_FONT_SIZE || size > MAX_FONT_SIZE) {
        return {
          content:
            `Invalid font size ${size}. Must be between ${MIN_FONT_SIZE} and ${MAX_FONT_SIZE}.`,
          isError: true,
        };
      }
    }

    // Parse optional editor filter
    const editorFilter =
      typeof obj['editor'] === 'string' ? obj['editor'] as string : undefined;

    // ── Discover targets ─────────────────────────────────────────────────────

    let targets = discover();

    // Validate filter against known editor names
    if (editorFilter !== undefined) {
      const normalizedFilter = normalizeEditorName(editorFilter);
      const knownNormalized = ['cursor', 'vscode', 'vscodeinsiders'];
      if (!knownNormalized.includes(normalizedFilter)) {
        return {
          content:
            `Unknown editor "${editorFilter}". Supported editors: Cursor, VS Code, VS Code Insiders.`,
          isError: true,
        };
      }
      targets = targets.filter(
        (t) => normalizeEditorName(t.name) === normalizedFilter,
      );
    }

    if (targets.length === 0) {
      const reason =
        editorFilter !== undefined
          ? `No settings.json found for editor "${editorFilter}".`
          : 'No supported editors detected (Cursor or VS Code not installed, or settings file not found).';
      return { content: reason };
    }

    // ── Dispatch action ──────────────────────────────────────────────────────

    if (action === 'get') {
      return handleGet(targets);
    }

    // action === 'set'
    return handleSet(targets, size as number, writeFn);
  };
}

// ── get action ───────────────────────────────────────────────────────────────

async function handleGet(
  targets: EditorTarget[],
): Promise<{ content: string; isError?: true }> {
  const lines: string[] = [];

  for (const target of targets) {
    const settingsPath = expandHome(target.path);

    if (!existsSync(settingsPath)) {
      lines.push(
        `${target.name}: terminal.integrated.fontSize = (default, ~12–14)`,
      );
      continue;
    }

    let raw: string;
    try {
      raw = await readFile(settingsPath, 'utf-8');
    } catch {
      lines.push(
        `${target.name}: (could not read settings — file may contain comments or be malformed)`,
      );
      continue;
    }

    let settings: Record<string, unknown>;
    try {
      settings = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      lines.push(
        `${target.name}: (could not read settings — file may contain comments or be malformed)`,
      );
      continue;
    }

    const val = settings['terminal.integrated.fontSize'];
    if (typeof val === 'number') {
      lines.push(`${target.name}: terminal.integrated.fontSize = ${val}`);
    } else {
      lines.push(
        `${target.name}: terminal.integrated.fontSize = (not set — editor default applies)`,
      );
    }
  }

  return { content: lines.join('\n') };
}

// ── set action ───────────────────────────────────────────────────────────────

async function handleSet(
  targets: EditorTarget[],
  size: number,
  writeFn: (path: string, data: string, encoding: BufferEncoding) => Promise<void>,
): Promise<{ content: string; isError?: true }> {
  const lines: string[] = [];
  let anyError = false;

  for (const target of targets) {
    const settingsPath = expandHome(target.path);
    let settings: Record<string, unknown> = {};

    // Try to read existing settings
    try {
      const raw = await readFile(settingsPath, 'utf-8');
      try {
        settings = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // JSONC or malformed — abort for this target to avoid overwriting
        lines.push(
          `${target.name}: could not update — settings file may contain comments or be malformed. ` +
          `Edit manually: ${settingsPath}`,
        );
        anyError = true;
        continue;
      }
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code !== 'ENOENT') {
        lines.push(
          `${target.name}: could not read settings — ${nodeErr.message}`,
        );
        anyError = true;
        continue;
      }
      // ENOENT → fresh empty settings object (safe to proceed)
      settings = {};
    }

    // Merge font size
    settings['terminal.integrated.fontSize'] = size;

    const tmpPath = `${settingsPath}.tmp`;
    const serialised = JSON.stringify(settings, null, 2) + '\n';

    try {
      await writeFn(tmpPath, serialised, 'utf-8');
      await rename(tmpPath, settingsPath);
      lines.push(`${target.name}: terminal.integrated.fontSize set to ${size}`);
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      lines.push(
        `${target.name}: could not write settings — ${nodeErr.message}`,
      );
      anyError = true;
    }
  }

  if (anyError) {
    return { content: lines.join('\n'), isError: true };
  }
  return { content: lines.join('\n') };
}

// ── Pre-wired default export ─────────────────────────────────────────────────

/** Module-level default handler using real `discoverEditors` and `writeFile`. */
export const terminalFontSizeHandler: ToolHandler = createTerminalFontSizeHandler();
