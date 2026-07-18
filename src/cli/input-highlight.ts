/**
 * Input-field token colorizer.
 *
 * Used by the raw-mode input box (`input-box.ts`) to paint trigger-shaped
 * tokens in the user's in-progress buffer:
 *   - `/<command>` registered  → palette.brand   (warm orange)
 *   - `/mint` (and `/<plugin>:mint`) → palette.mint (mint green — per-command override)
 *   - `/<command>` unknown     → palette.meta    (dim)
 *   - `@<path>` file reference → palette.fileRef (teal)
 *
 * The visual goal: when the user types `/mint` or `@src/index.ts`, the
 * trigger token reads as a distinct chip rather than blending into the
 * surrounding prose — same affordance the dropdown surfaces below.
 *
 * ANSI escapes are zero-width — wrapping a token in chalk does not change
 * `string.length`, which is critical because the input box's cursor math uses
 * `input.cursor` against the *uncolored* buffer. This module is read-only:
 * it returns a new string for `stdout.write` and never feeds back into cursor
 * computation.
 *
 * When chalk is disabled (NO_COLOR / CI / non-TTY → `chalk.level === 0`),
 * returns the buffer untouched.
 */

import chalk from 'chalk';
import { palette } from './palette.js';

/**
 * Minimal view of the slash registry sufficient to decide brand-vs-meta.
 * Adapted by the caller from whatever the underlying registry exposes
 * (see `slash/registry.ts#list`). Keeping this narrow keeps the highlighter
 * decoupled from the registry's full surface.
 */
export interface SlashRegistryView {
  has(name: string): boolean;
  /**
   * Optional opaque, monotonic token that changes whenever registry
   * membership changes (see `slash/registry.ts#registryVersion`). When
   * supplied, `colorizeInputBuffer` memoizes identical consecutive calls
   * keyed on it, so a plugin/skill hot-swap invalidates the cache and never
   * serves a stale-colored buffer. When ABSENT, the memo is disabled for
   * that call (falls back to recomputation) — a correct-but-uncached result
   * is always safer than a stale one.
   */
  version?(): number;
}

// Slash token anywhere in buffer. Must sit at the start of the string or
// after whitespace, and be followed by whitespace or end-of-buffer so we
// don't paint partial words mid-typing. Global flag: one buffer can contain
// multiple slash commands.
const SLASH_TOKEN_RE = /(?<=\s|^)(\/[A-Za-z][\w:-]*)(?=\s|$)/g;

// File-reference token (`@<path>`). Same boundary rules as the slash token:
// must follow whitespace or buffer start so words like `email@host` aren't
// painted. Trailing boundary is permissive — `@` alone is enough to highlight
// (signals an open file trigger), and the path body accepts the chars
// `fileMatchesFor` actually emits: alphanumerics plus `._/-`, plus a leading
// `~` so home-relative refs (`@~/foo`, `@~/.afk/config`) highlight too.
// Absolute refs (`@/etc/hosts`) already matched via `/`. Anchoring on `\s|$`
// at the end keeps mid-token highlighting from happening while the user is
// still typing a word that just happens to contain `@`.
const FILE_TOKEN_RE = /(?<=\s|^)(@[~\w./-]*)(?=\s|$)/g;

// Paste-truncation placeholder — emitted by terminal-compositor.ts when a
// bracketed paste exceeds the size thresholds. Visually styled dim so the
// user reads it as "stub for stashed content" rather than "literal text I
// typed." Anchorless on purpose — the placeholder format is distinctive
// enough (literal `[Pasted text #` prefix) that no boundary check is needed;
// the cost of a false positive is purely cosmetic.
//
// Pattern shape MUST stay in sync with the recognizer in terminal-compositor.ts
// (which adds a capture group `(\d+)` for the registry id — omitted here since
// the colorizer only needs match positions, not the id). If the placeholder
// token format changes (prefix, unit keywords, or delimiter structure), update
// both copies. The compositor owns the canonical format; this copy is colorizer-
// only to keep the dependency graph cycle-free.
const PASTE_PLACEHOLDER_RE = /\[Pasted text #[0-9a-f]+ \+\d+ (?:lines|chars)\]/g;

/**
 * Per-command tone overrides for the registered-token branch. Most known
 * commands render in `palette.brand` (warm orange); entries in this map
 * opt a specific command name into a different palette tone instead. Only
 * applies when the registry confirms the command exists — unknown tokens
 * still fall through to `palette.meta` regardless of any entry here.
 *
 * Matching is exact on the slash-token name (the part after `/`). For
 * namespaced invocations like `/example-plugin:mint` we additionally match on
 * the post-colon suffix, so plugin-scoped forms of a special-cased command
 * pick up the same tone as the bare form.
 */
const TOKEN_TONE_OVERRIDES: Record<string, (s: string) => string> = {
  // /mint — color pun on the skill name. The mint-green chip visually
  // separates a /mint invocation from every other registered command in the
  // input buffer.
  mint: palette.mint,
};

/**
 * Resolve the tone to use for a known slash-token name. Returns `null` if
 * the name has no override and the caller should fall back to the default
 * known-command tone (`palette.brand`).
 */
function toneForKnownToken(name: string): ((s: string) => string) | null {
  const direct = TOKEN_TONE_OVERRIDES[name];
  if (direct) return direct;
  // Namespaced form: `<plugin>:<bare>` → match on the post-colon segment so
  // `/example-plugin:mint` and `/user:mint` pick up the same tone as `/mint`.
  const colon = name.lastIndexOf(':');
  if (colon >= 0) {
    const bare = name.slice(colon + 1);
    const nested = TOKEN_TONE_OVERRIDES[bare];
    if (nested) return nested;
  }
  return null;
}

// Invariant: single-entry memo for `colorizeInputBuffer`. The colorizer runs
// three whole-buffer regex `.replace` passes and is called on EVERY keystroke
// (per repaint), yet the buffer is usually identical between consecutive
// repaints (cursor moves, no-op keys, dropdown navigation). Caching the last
// (input, chalk.level, registry-version) → output collapses those repeats to
// an O(1) equality check.
//
// Honesty of the key — the output is a pure function of exactly three inputs,
// and the memo keys on all three:
//   1. `buffer`      — the token text being colored;
//   2. `chalk.level` — 0 short-circuits to the raw buffer; any nonzero level
//                      emits ANSI, and chalk bakes the level into the escape
//                      it produces, so a level change must miss the cache;
//   3. registry membership — a token colors brand/mint (known) vs meta
//                      (unknown) purely by `registry.has(name)`. We capture
//                      this via the registry's monotonic `version()`; when a
//                      command is registered/replaced/reset the version moves
//                      and the cache misses. Without a `version()` the memo is
//                      DISABLED (recompute every call) — never risk staleness.
// We ALSO key on the registry-view object identity: two distinct views can
// legitimately report the same `version()` while answering `has()` differently
// (each carries its own monotonic counter), so identity guards against one
// view serving another's cached output. In production there is a single shared
// registry, so this is belt-and-suspenders — but it keeps the memo sound if a
// second view is ever introduced. The palette tones are module-frozen (see
// palette.ts), so they are not part of the key. A single entry suffices
// (consecutive repaints share one buffer) and cannot grow unbounded.
let memoBuffer: string | null = null;
let memoLevel: number | null = null;
let memoVersion: number | null = null;
let memoRegistry: SlashRegistryView | null = null;
let memoOutput = '';

/**
 * Return `buffer` with every recognized trigger token wrapped in palette
 * colors. The output's printable length matches the input — only ANSI
 * escapes are inserted.
 */
export function colorizeInputBuffer(
  buffer: string,
  registry: SlashRegistryView,
): string {
  if (chalk.level === 0) return buffer;

  // Only memoize when the registry exposes a version — otherwise we cannot
  // honestly know whether membership changed since the last call, so we
  // recompute (correct, just uncached).
  const version = registry.version?.();
  const canMemo = version !== undefined;
  if (
    canMemo &&
    memoRegistry === registry &&
    memoBuffer === buffer &&
    memoLevel === chalk.level &&
    memoVersion === version
  ) {
    return memoOutput;
  }

  // Order matters for nesting safety, not semantics: the three regexes
  // match disjoint shapes (slash starts with `/`, file with `@`, paste
  // placeholder with `[`). Apply in any order — done in declaration
  // order so the existing ANSI-shape tests stay stable.
  const withSlash = buffer.replace(SLASH_TOKEN_RE, (token) => {
    const name = token.slice(1);
    if (!registry.has(name)) return palette.meta(token);
    const tone = toneForKnownToken(name) ?? palette.brand;
    return tone(token);
  });
  const withFile = withSlash.replace(FILE_TOKEN_RE, (token) => palette.fileRef(token));
  const output = withFile.replace(PASTE_PLACEHOLDER_RE, (token) => palette.meta(token));

  if (canMemo) {
    memoRegistry = registry;
    memoBuffer = buffer;
    memoLevel = chalk.level;
    memoVersion = version!;
    memoOutput = output;
  }
  return output;
}
