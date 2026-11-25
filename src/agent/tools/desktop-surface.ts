/**
 * Opt-in desktop tool surface.
 *
 * `desktop_screenshot` (and future desktop input tools) are added to the
 * provider's tool list ONLY when `AFK_DESKTOP_ENABLED` is set. When the flag
 * is off the default tool surface is byte-identical to before this branch,
 * which matters for prompt-cache stability.
 *
 * Pattern: mirrors `readonly-git-surface.ts` (#3754). The gating function
 * `desktopSchemas()` returns `[desktopScreenshotTool]` when enabled and `[]`
 * otherwise. `buildProviderSchemas` appends it after the builtin tail, so the
 * invariant core prefix is never affected.
 *
 * The handler keeps its own second-line-of-defence refusal (the
 * `AFK_DESKTOP_ENABLED` gate in `acquireDesktopBackend`) so that a handler
 * registered via a different code path cannot accidentally expose the tool.
 *
 * @module agent/tools/desktop-surface
 */

import { env } from '../../config/env.js';
import { isExplicitlyEnabled } from '../../config/env-helpers.js';
import { desktopScreenshotTool } from './schemas.desktop-tools.js';
import type { AnthropicToolDef } from './types.js';

/** True when `AFK_DESKTOP_ENABLED` is set to 1/true/yes/on. Read live per call. */
export function isDesktopEnabled(): boolean {
  const raw = env.AFK_DESKTOP_ENABLED;
  return raw !== undefined && isExplicitlyEnabled(raw);
}

/**
 * Schemas to append to a provider's builtin list: `[desktopScreenshotTool]`
 * while `AFK_DESKTOP_ENABLED` is on, `[]` otherwise (default surface
 * byte-identical). Evaluated at provider construction.
 */
export function desktopSchemas(): AnthropicToolDef[] {
  return isDesktopEnabled() ? [desktopScreenshotTool] : [];
}

/** Names for top-level allowlists, gated identically to the advertised schemas. */
export function desktopToolNames(): string[] {
  return desktopSchemas().map((schema) => schema.name);
}
