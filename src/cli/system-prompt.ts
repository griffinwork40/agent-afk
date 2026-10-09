import { readFileSync, existsSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import { fileURLToPath } from 'url';

import { env } from '../config/env.js';
import { loadConfig } from './config.js';

/**
 * Load the framework base system prompt.
 *
 * When `AFK_FRAMEWORK_PROMPT_FILE` is set (non-blank), that file replaces the
 * bundled `system-prompt.md` so `afk whatif --env AFK_FRAMEWORK_PROMPT_FILE=<path>`
 * can A/B test framework prompt edits without touching the checked-in file.
 * Unset = the bundled prompt, byte-identical to prior behaviour.
 *
 * **Fail-closed contract:** a relative path or an unreadable file **throws**.
 * Silently running with the bundled prompt would turn an A/B run into A/A and
 * measure nothing. There is no fallback — the loud failure is the point.
 *
 * **Reach:** this throw propagates to every surface that builds a system prompt:
 *   - Startup (CLI, Telegram) — the process crashes with a clear message. ✓ acceptable.
 *   - Mid-session `/afk-md reload` — caught by `applyReload()`, surfaced as
 *     an error line; the REPL stays alive, the prompt is unchanged.
 *   - Mid-server `afk web` session-create — caught by `SessionOwner.create()`,
 *     re-thrown as an actionable message; the request fails, other sessions live.
 *
 * **Recommendation:** only ever set this variable transiently via
 * `afk whatif --env AFK_FRAMEWORK_PROMPT_FILE=<path>`. A value persisted in
 * `~/.afk/config/afk.env` blocks every surface until removed.
 */
export function loadSystemPrompt(): string | undefined {
  const override = env.AFK_FRAMEWORK_PROMPT_FILE?.trim();
  if (override) {
    // path.isAbsolute, not a leading-slash check, so Windows absolute paths
    // such as C:\prompts\x.md are accepted on Windows CI and hosts.
    if (!isAbsolute(override)) {
      throw new Error(
        `AFK_FRAMEWORK_PROMPT_FILE="${override}" must be an absolute path (got a relative path).`,
      );
    }
    try {
      return readFileSync(override, 'utf-8');
    } catch (err) {
      throw new Error(
        `AFK_FRAMEWORK_PROMPT_FILE="${override}" is unreadable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return loadBundledSystemPrompt();
}

/**
 * Load the runtime system prompt from the installed package
 * (`<root>/system-prompt.md`), not from the user's cwd. Resolves
 * correctly from both the compiled `dist/cli/` and the source `src/cli/`
 * locations.
 *
 * Invariant: this function body is matched byte-for-byte by Pattern C in
 * `scripts/esbuild-plugin-inline-prompts.mjs`, which replaces it with the
 * inlined prompt text in the published bundle. Edit both together.
 *
 * Works for any provider — the Codex adapter writes the resolved text to a
 * temp `model_instructions_file` when the Anthropic preset conventions
 * don't map cleanly.
 */
export function loadBundledSystemPrompt(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const promptPath = resolve(here, '..', '..', 'system-prompt.md');
  if (!existsSync(promptPath)) return undefined;
  try {
    return readFileSync(promptPath, 'utf-8');
  } catch {
    return undefined;
  }
}

/**
 * Load systemPrompt from env or afk.config.json, if set.
 * Precedence: AFK_SYSTEM_PROMPT env > cwd/afk.config.json >
 *   ~/.afk/config/afk.config.json > legacy ~/.afk.config.json >
 *   AFK.md (cwd + $AFK_HOME/, combined additively when both exist —
 *   project-scope text is appended after personal-scope text and wins on
 *   conflict; see `loadAfkMd()` in `config/afk-md-tier.ts`).
 * Mirrors the telegram entrypoint so CLI and bot read the same config surface.
 *
 * Delegates to `loadConfig()` to share the same 3-tier walk and disk-cache.
 * Previously this function did its own duplicate walk — a measurable
 * cold-start tax since `afk chat` calls both `loadConfigSystemPrompt()`
 * (here) and `loadConfig()` (for provenance) on the same critical path.
 * The two are documented as identical in production (see chat.ts:132-137);
 * routing both through `loadConfig()` makes them share work.
 */
export function loadConfigSystemPrompt(): string | undefined {
  return loadConfig().systemPrompt;
}

/**
 * Header inserted between the framework base prompt and the operator overlay.
 *
 * Invariant: only emitted when BOTH a framework base and an overlay are
 * present (see {@link composeSystemPrompt}). The "above" reference therefore
 * never dangles — it always points at the framework operating posture.
 */
export const OPERATOR_CONFIG_HEADER =
  '# Operator configuration\n\n' +
  "The instructions below come from this operator's configuration (AFK.md, " +
  'afk.config.json, or AFK_SYSTEM_PROMPT). Treat them as refinements layered ' +
  'on top of the operating posture above — follow them unless they conflict ' +
  'with the Priorities or Constraints already stated.';

/**
 * Compose the final base system prompt from the unconditional framework base
 * and the optional operator overlay.
 *
 * Contract: the framework base (`system-prompt.md`) is the foundation
 * whenever present; the overlay is APPENDED beneath {@link OPERATOR_CONFIG_HEADER},
 * never substituted for the base. Empty / whitespace-only inputs are treated
 * as absent so a blank AFK.md or a missing prompt file never injects a
 * dangling header or a leading newline.
 *   - both present  → `${framework}\n\n${header}\n\n${overlay}`
 *   - framework only → framework
 *   - overlay only   → overlay (framework genuinely absent — dev/test edge)
 *   - neither        → undefined
 */
export function composeSystemPrompt(
  framework: string | undefined,
  overlay: string | undefined,
): string | undefined {
  const fw = framework !== undefined && framework.trim().length > 0 ? framework : undefined;
  const ov = overlay !== undefined && overlay.trim().length > 0 ? overlay : undefined;
  if (fw === undefined) return ov;
  if (ov === undefined) return fw;
  return `${fw}\n\n${OPERATOR_CONFIG_HEADER}\n\n${ov}`;
}

/**
 * Resolve the surface base system prompt: the unconditional framework base
 * (`system-prompt.md`, inlined at publish-build) with the resolved
 * operator overlay (`AFK_SYSTEM_PROMPT` → `afk.config.json` → `AFK.md`)
 * appended on top. Used by every top-level surface (one-shot `chat`, REPL,
 * Telegram, farm) so they share one layering rule.
 *
 * Returns the composed `prompt` plus a layered `source` string for
 * `--dump-prompt` provenance: `framework+<overlaySource>` when both are
 * present, `framework` when only the base is, `<overlaySource>` when only the
 * overlay is (framework absent), or `none`. The plain overlay source remains
 * available unchanged via `loadConfig().systemPromptSource`.
 *
 * Contract: `overlay` is the bare operator overlay (no framework, no header),
 * `undefined` when absent or whitespace-only. Surfaces thread it to the
 * `agent` executor so unnamed subagents, which do NOT receive the composed
 * `prompt`, still carry the operator's instructions (#3324).
 */
export function resolveBaseSystemPrompt(cwd: string = process.cwd()): { prompt: string | undefined; source: string; overlay?: string } {
  const framework = loadSystemPrompt();
  const cfg = loadConfig(undefined, cwd);
  const overlay = cfg.systemPrompt;
  const overlaySource = cfg.systemPromptSource;
  const hasFw = framework !== undefined && framework.trim().length > 0;
  const hasOv = overlay !== undefined && overlay.trim().length > 0;
  let source: string;
  if (hasFw && hasOv) source = `framework+${overlaySource ?? 'unknown'}`;
  else if (hasFw) source = 'framework';
  else if (hasOv) source = overlaySource ?? 'unknown';
  else source = 'none';
  return { prompt: composeSystemPrompt(framework, overlay), source, ...(hasOv ? { overlay } : {}) };
}
