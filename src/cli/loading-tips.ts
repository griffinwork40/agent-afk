/**
 * Loading-screen tips — rotating "did-you-know" hints surfaced beneath the
 * TerminalCompositor spinner while a model turn is in flight.
 *
 * Modeled on the video-game loading-screen pattern: a slowly-rotating sub-line
 * that surfaces guidance about commands the user could be using. Pool is
 * harvested from live registries so adding a skill or command automatically
 * grows the tip pool — no parallel list to maintain.
 *
 * Three quality knobs the spinner consumer must respect:
 *
 *   1. **Warmup gate.** Don't render a tip for the first ~1500ms of any
 *      spinner. Quick turns (cached / trivial / cancelled) finish before
 *      then; rendering a tip and immediately tearing it down is worse than
 *      no tip. This is the explicit "annoyance-mitigation" guidance from
 *      external prior art (Docker, Claude Code).
 *
 *   2. **Time-stable rotation.** `selectTip` picks based on
 *      `Math.floor(now / rotateMs)` so the same tip survives every paint
 *      within a window. Per-frame increment would flicker mid-read.
 *
 *   3. **Seen-tracking.** First exposure to a tip is the most valuable; the
 *      pool prefers unseen tips until exhausted. Once everything is seen,
 *      falls back to deterministic round-robin so demo behaviour is
 *      reproducible.
 *
 * Tips are plain text — no ANSI inside the body, no second sentence. The
 * compositor wraps them with the dim 💡 prefix.
 */

import { list as listSlashCommands } from './slash/registry.js';
import { listSkills, getSkill, isSkillVisible } from '../skills/index.js';
import { env } from '../config/env.js';

export interface LoadingTip {
  /** Display text. Leading "Tip: " is added by the compositor; body only. */
  text: string;
  /** Tag used by tests + seen-tracking to identify a tip across rotations. */
  id: string;
  /** Where the tip came from — diagnostic only, not surfaced to the user. */
  source: 'static' | 'command' | 'skill';
}

/**
 * Static fallback tips for kbd shortcuts and surfaces that aren't slash
 * commands. Always included regardless of what's registered.
 */
const STATIC_TIPS: readonly LoadingTip[] = [
  {
    id: 'kbd:ctrl-b',
    text: 'Ctrl+B during a turn detaches it to the background so you can keep typing — find it later with /tasks.',
    source: 'static',
  },
  {
    id: 'kbd:shift-tab',
    text: 'Shift+Tab toggles plan mode (no file writes) without leaving the prompt.',
    source: 'static',
  },
  {
    id: 'kbd:ctrl-c',
    text: 'Ctrl+C interrupts the current turn; press it twice in a row to exit the REPL.',
    source: 'static',
  },
  {
    id: 'kbd:at-path',
    text: 'Type @ in the prompt to autocomplete a file path and attach its contents to your turn.',
    source: 'static',
  },
  {
    id: 'kbd:cmd-v',
    text: 'Paste an image with Cmd+V (macOS) or Ctrl+V — clipboard images attach automatically.',
    source: 'static',
  },
  {
    id: 'env:tips-opt-out',
    text: 'Set AFK_SPINNER_TIPS=0 to silence these loading-screen tips.',
    source: 'static',
  },
];

/**
 * Harvest tips from currently-registered slash commands. Uses the `hint`
 * field (the "when to use" tooltip metadata). Commands without a hint are
 * skipped — the dropdown tooltip already shows the same text, so reusing it
 * here keeps the two surfaces in lockstep without a parallel string table.
 *
 * Filters out plugin-namespaced commands (e.g. `/example-plugin:mint`) — the
 * bare-named winner is reachable as the same skill, so showing both forms
 * just duplicates the tip pool.
 */
function harvestCommandTips(): LoadingTip[] {
  const out: LoadingTip[] = [];
  for (const cmd of listSlashCommands()) {
    if (!cmd.hint) continue;
    // Skip namespaced plugin forms — the bare alias (when present) is the
    // canonical entrypoint and contributes its own tip.
    if (cmd.name.includes(':')) continue;
    out.push({
      id: `cmd:${cmd.name}`,
      text: `${cmd.name} — ${cmd.hint}`,
      source: 'command',
    });
  }
  return out;
}

/**
 * Harvest tips from registered built-in skills. Pulls the structured
 * `whenToUse` field rather than the freeform description — skill authors
 * curate whenToUse specifically for "tell the model when to reach for me,"
 * which is exactly the framing a loading-screen tip needs.
 *
 * Avoids duplicating with command-harvest by skipping skills whose name has
 * already been registered as a slash command with a hint (the command form
 * wins — it carries the same text and the slash form is what the user
 * actually types).
 */
function harvestSkillTips(commandTipIds: ReadonlySet<string>): LoadingTip[] {
  const out: LoadingTip[] = [];
  for (const name of listSkills()) {
    const slashId = `cmd:/${name}`;
    if (commandTipIds.has(slashId)) continue;
    // `getSkill` throws when the registry entry vanishes between
    // `listSkills()` and the lookup — a TOCTOU window that triggers if a
    // plugin unloads or the registry is reset mid-build. The tip pool is
    // best-effort decoration; one missing skill must not break spinner
    // arming.
    let skill;
    try {
      skill = getSkill(name);
    } catch {
      continue;
    }
    if (!isSkillVisible(skill, env.AFK_INTERNAL === '1')) continue;
    if (!skill.whenToUse) continue;
    out.push({
      id: `skill:${name}`,
      text: `/${name} — ${skill.whenToUse}`,
      source: 'skill',
    });
  }
  return out;
}

/**
 * Build the merged tip pool. Cheap — call once per spinner arm() at most.
 * Honors the AFK_SPINNER_TIPS=0 opt-out by returning an empty pool, which
 * the compositor reads as "render no tip slot."
 */
export function buildTipPool(): LoadingTip[] {
  if (env.AFK_SPINNER_TIPS === '0') return [];
  const commandTips = harvestCommandTips();
  const commandIds = new Set(commandTips.map((t) => t.id));
  const skillTips = harvestSkillTips(commandIds);
  return [...STATIC_TIPS, ...commandTips, ...skillTips];
}

/**
 * In-session seen-tip tracker. Module-scope on purpose: tips should rotate
 * across consecutive turns within one REPL session, not reset on every arm().
 * Reset between sessions naturally — the module reloads with the process.
 */
const seenTipIds = new Set<string>();

/**
 * Memoization for one (startedAt, rotateIdx) → tip pick.
 *
 * `selectTip` is called every 80ms by the compositor's tick. Without
 * memoization, each call within the same rotation window would compute a
 * fresh "unseen" index — but the *first* call in a window mutates the seen
 * set, so the *second* call sees a smaller `unseenCount` and picks a
 * different tip, breaking time-stability. The cache pins the answer to the
 * rotation window so every call inside one window returns the same tip and
 * the seen set advances exactly once per window.
 *
 * Key shape: `${startedAt}:${rotateIdx}`. `startedAt` namespaces by spinner
 * arm — a new arm resets every key, which is correct (the new spinner
 * deserves a fresh rotation 0 even if the session has stale entries).
 */
const tipPickCache = new Map<string, LoadingTip>();

/** Test hook — reset the seen tracker. Not exported in production paths. */
export function _resetSeenTipsForTesting(): void {
  seenTipIds.clear();
  tipPickCache.clear();
}

export interface SelectTipOpts {
  /** Spinner armed-at timestamp; tip stays null until warmupMs has elapsed. */
  startedAt: number;
  /** Current time. Injectable for tests; defaults to Date.now(). */
  now?: number;
  /** Rotate window in ms. Default 7000 — slower than the verb's 3500. */
  rotateMs?: number;
  /** Warmup grace before any tip renders. Default 1500. */
  warmupMs?: number;
}

/**
 * Pick the tip to render for the current spinner frame.
 *
 * Returns null when:
 *   - the pool is empty (AFK_SPINNER_TIPS=0, or no hints registered yet)
 *   - the spinner hasn't been alive for `warmupMs` yet (quick-turn suppression)
 *
 * Selection algorithm: prefer the first unseen tip in pool order. Once every
 * tip has been seen at least once, fall back to time-stable index rotation
 * `floor((now - startedAt) / rotateMs) % pool.length`. Records each returned
 * tip's id in the seen set as a side effect — that's the only way "prefer
 * unseen" can drain the pool across rotations.
 */
export function selectTip(
  pool: readonly LoadingTip[],
  opts: SelectTipOpts,
): LoadingTip | null {
  if (pool.length === 0) return null;
  const now = opts.now ?? Date.now();
  const warmup = opts.warmupMs ?? 1500;
  if (now - opts.startedAt < warmup) return null;

  const rotateMs = opts.rotateMs ?? 7000;
  const rotateIdx = Math.floor((now - opts.startedAt) / rotateMs);

  // Memoize the pick per (startedAt, rotateIdx) so the answer is stable for
  // every call inside one rotation window. This is the load-bearing
  // invariant for "no flicker mid-read" and for the seen-tracker advancing
  // exactly once per window.
  const cacheKey = `${opts.startedAt}:${rotateIdx}`;
  const cached = tipPickCache.get(cacheKey);
  if (cached) return cached;

  let pick: LoadingTip | null = null;

  // First pass: serve unseen tips. The time-stable rotateIdx advances every
  // rotateMs, so consecutive rotations pick *different* unseen tips rather
  // than the same first-unseen-in-pool-order every window.
  const unseen = pool.filter((t) => !seenTipIds.has(t.id));
  if (unseen.length > 0) {
    const idx = ((rotateIdx % unseen.length) + unseen.length) % unseen.length;
    pick = unseen[idx] ?? null;
  } else {
    // Fallback: every tip seen. Deterministic round-robin so the same window
    // always picks the same tip.
    const idx = ((rotateIdx % pool.length) + pool.length) % pool.length;
    pick = pool[idx] ?? null;
  }

  if (pick) {
    seenTipIds.add(pick.id);
    tipPickCache.set(cacheKey, pick);
  }
  return pick;
}
