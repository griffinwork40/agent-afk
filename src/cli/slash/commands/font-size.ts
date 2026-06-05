/**
 * /font-size slash command — direct REPL shortcut to the terminal_font_size tool.
 *
 * Provides a deterministic, instant path to read or change the terminal font
 * size in Cursor / VS Code / VS Code Insiders without involving the LLM and
 * without going through the write-permission gate. Shares the underlying
 * handler with the agent-facing built-in tool, so JSONC safety, atomic
 * writes (.tmp + rename), and editor auto-discovery behave identically
 * across both surfaces.
 *
 * Usage:
 *   /font-size              — show current sizes across detected editors
 *   /font-size 18           — set to 18 on all detected editors
 *   /font-size 14 cursor    — set to 14 on Cursor only (case-insensitive)
 *
 * Slash commands only fire in the interactive REPL — the `afk chat` one-shot
 * and Telegram surfaces still go through the agent tool path. This is a
 * second surface on the same handler, not a replacement.
 */

import { terminalFontSizeHandler } from '../../../agent/tools/handlers/terminal-font-size.js';
import type { ToolHandler } from '../../../agent/tools/types.js';
import type { SlashCommand } from '../types.js';

/**
 * Factory accepting a `handler` injection seam for tests. Production callers
 * use the default `terminalFontSizeHandler`; tests pass a spy.
 */
export function createFontSizeCmd(handler: ToolHandler = terminalFontSizeHandler): SlashCommand {
  return {
    name: '/font-size',
    summary: 'Get or set the terminal font size in Cursor / VS Code',
    usage: '/font-size [size] [editor]',
    hint:
      'Direct shortcut to the terminal_font_size tool — bypasses the LLM and the ' +
      'first-write permission prompt. Examples: `/font-size` (read all), ' +
      '`/font-size 18` (set all), `/font-size 14 cursor` (set Cursor only).',
    async handler(ctx, args) {
      const tokens = args.split(/\s+/).filter(Boolean);
      // Tool dispatcher normally provides a per-turn AbortSignal; slash
      // commands run synchronously in the REPL so a fresh, never-aborted
      // controller is the natural substitute.
      const ac = new AbortController();

      // No args → read current sizes across all detected editors.
      if (tokens.length === 0) {
        const result = await handler({ action: 'get' }, ac.signal);
        if (result.isError) ctx.out.error(result.content);
        else ctx.out.line(result.content);
        return 'continue';
      }

      const sizeStr = tokens[0]!;
      const size = Number(sizeStr);
      if (!Number.isFinite(size)) {
        ctx.out.error(
          `Invalid size: "${sizeStr}". Usage: /font-size [size] [editor]`,
        );
        return 'continue';
      }

      // Second token, if present, is the editor name. We let the underlying
      // handler validate it (case-insensitive + space-stripped matching);
      // unknown editor names surface as a structured error from the handler.
      const editor = tokens[1];
      const input: Record<string, unknown> = { action: 'set', size };
      if (editor !== undefined) input['editor'] = editor;

      const result = await handler(input, ac.signal);
      if (result.isError) ctx.out.error(result.content);
      else ctx.out.success(result.content);
      return 'continue';
    },
  };
}

/** Default-wired command registered in `slash/index.ts`. */
export const fontSizeCmd: SlashCommand = createFontSizeCmd();
