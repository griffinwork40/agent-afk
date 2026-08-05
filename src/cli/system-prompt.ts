import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { loadConfig } from './config.js';

/**
 * Load the runtime system prompt from the installed package
 * (`<root>/prompts/system-prompt.md`), not from the user's cwd. Resolves
 * correctly from both the compiled `dist/cli/` and the source `src/cli/`
 * locations.
 *
 * Works for any provider — the Codex adapter writes the resolved text to a
 * temp `model_instructions_file` when the Anthropic preset conventions
 * don't map cleanly.
 */
export function loadSystemPrompt(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const promptPath = resolve(here, '..', '..', 'prompts', 'system-prompt.md');
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
 * Contract: the framework base (`prompts/system-prompt.md`) is the foundation
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
 * (`prompts/system-prompt.md`, inlined at publish-build) with the resolved
 * operator overlay (`AFK_SYSTEM_PROMPT` → `afk.config.json` → `AFK.md`)
 * appended on top. Used by every top-level surface (one-shot `chat`, REPL,
 * Telegram, farm) so they share one layering rule.
 *
 * Returns the composed `prompt` plus a layered `source` string for
 * `--dump-prompt` provenance: `framework+<overlaySource>` when both are
 * present, `framework` when only the base is, `<overlaySource>` when only the
 * overlay is (framework absent), or `none`. The plain overlay source remains
 * available unchanged via `loadConfig().systemPromptSource`.
 */
export function resolveBaseSystemPrompt(cwd: string = process.cwd()): { prompt: string | undefined; source: string } {
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
  return { prompt: composeSystemPrompt(framework, overlay), source };
}
