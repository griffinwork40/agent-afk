/**
 * PostToolUse hook: render generated/captured images inline in the terminal.
 *
 * Fires after `image_generate`, `image_edit`, and `browser_screenshot` tool
 * calls succeed. Extracts the saved file path from the tool result JSON and
 * delegates rendering to {@link renderInlineImage}, which handles terminal
 * detection, protocol selection, and the AFK_INLINE_IMAGES opt-out flag.
 *
 * Non-blocking: always returns `{}` so a render failure never prevents the
 * model turn from proceeding.
 *
 * Skipped for:
 * - Error results (`isError: true`)
 * - Subagent sessions (no terminal to render into)
 * - Non-interactive surfaces (daemon / Telegram) detected via `process.stdout.isTTY`
 *
 * @module agent/tools/hooks/inline-image-hook
 */

import type { HookContext, HookDecision, HookHandler } from '../../hooks.js';
import { isSubagentContext } from '../../hooks/hook-utils.js';
import { renderInlineImage } from './inline-image-render.js';

// ---------------------------------------------------------------------------
// Supported tools
// ---------------------------------------------------------------------------

/** Tools whose results may contain an image file path to render. */
const IMAGE_TOOLS = new Set(['image_generate', 'image_edit', 'browser_screenshot']);

// ---------------------------------------------------------------------------
// Path extraction
// ---------------------------------------------------------------------------

/**
 * Extract the absolute image file path from a tool result `output` value.
 *
 * `image_generate` and `image_edit` return JSON with a top-level `"path"` key.
 * `browser_screenshot` returns JSON with a top-level `"path"` key as well.
 * Both formats are handled identically here.
 *
 * Returns `undefined` when the output is not parseable or lacks a `"path"` key.
 */
function extractImagePath(output: unknown): string | undefined {
  if (typeof output !== 'string' || output.trim().length === 0) return undefined;
  try {
    const parsed = JSON.parse(output) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'path' in parsed &&
      typeof (parsed as Record<string, unknown>)['path'] === 'string'
    ) {
      return (parsed as Record<string, unknown>)['path'] as string;
    }
  } catch {
    // Not JSON — ignore.
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the PostToolUse hook that renders images inline in the terminal.
 *
 * Returns a {@link HookHandler} to register on the `PostToolUse` event. The
 * handler is always non-blocking (returns `{}`). Rendering is async but the
 * hook framework awaits the return promise before proceeding, so the image
 * appears before the next model turn begins.
 */
export function createInlineImageHook(agentCwd?: string | undefined): HookHandler {
  return async (context: HookContext): Promise<HookDecision> => {
    // Guard: PostToolUse only.
    if (context.event !== 'PostToolUse') return {};

    // Guard: only the image-producing tools.
    if (!IMAGE_TOOLS.has(context.toolName)) return {};

    // Guard: skip error results — there is no image to show.
    if (context.isError) return {};

    // Guard: subagents have no interactive terminal.
    if (isSubagentContext(context)) return {};

    // Guard: non-TTY surfaces (daemon, Telegram, piped output).
    if (!process.stdout.isTTY) return {};

    const filePath = extractImagePath(context.output);
    if (!filePath) return {};

    // Fire-and-forget style from the caller's perspective, but we await here
    // so the image renders before the next turn prompt appears.
    await renderInlineImage({ filePath, toolName: context.toolName, agentCwd });

    return {};
  };
}
