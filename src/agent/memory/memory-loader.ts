/**
 * Pre-session memory loader.
 *
 * Loads HOT.md and injects it into the system prompt in AgentConfig
 * before session construction. Must be called before new AgentSession().
 *
 * The system prompt is baked at provider construction time and cannot be
 * modified after session construction, so memory injection must happen
 * in the AgentConfig before the session is created.
 *
 * @module agent/memory/memory-loader
 */

import { existsSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, basename, isAbsolute, resolve } from 'path';
import { getMemoryDir } from '../../paths.js';
import type { AgentConfig } from '../types/config-types.js';
import { env } from '../../config/env.js';
import { debugLog } from '../../utils/debug.js';
import { MemoryStore } from './memory-store.js';
import { estimateTokens } from './estimate-tokens.js';
import type { Fact } from './types.js';

/**
 * Load HOT.md from memory store.
 *
 * Returns null if the file doesn't exist, can't be read, or contains
 * only whitespace.
 */
export function loadHotMemory(): string | null {
  const path = join(getMemoryDir(), 'HOT.md');
  if (!existsSync(path)) return null;

  try {
    const content = readFileSync(path, 'utf-8');
    return content.trim().length > 0 ? content : null;
  } catch {
    // File unreadable (permissions, I/O error) — treat as empty
    return null;
  }
}

/**
 * Inject HOT.md into an AgentConfig as the dedicated `hotMemory` field.
 *
 * If HOT.md doesn't exist or is empty, returns the config unchanged.
 * Otherwise, wraps the hot memory in `<cross-session-memory>` tags and stores
 * it on `config.hotMemory` — a field the provider places in the
 * cross-session-memory region of the assembled system prompt (after the memory
 * instructions).
 *
 * Invariant: hot memory is carried as its own field rather than prepended into
 * `systemPrompt`. `systemPrompt` holds the `# Agent AFK` doctrine + operator
 * overlay + routing/end-of-turn directives, which the provider now places
 * EARLY (right after the tool conventions); welding hot memory onto the front
 * of that string would drag the cross-session-memory block ahead of the
 * doctrine. Keeping the two separate lets the assembler order them
 * independently. See `providers/anthropic-direct/query/system-prompt.ts`.
 *
 * Does not mutate the original config — returns a shallow copy.
 */
export function injectHotMemory(config: AgentConfig): AgentConfig {
  const hot = loadHotMemory();
  if (!hot) return config;

  const sanitized = hot.replace(/<\/?cross-session-memory\b[^>]*>/gi, '');
  const memoryBlock = `<cross-session-memory>\n${sanitized}\n</cross-session-memory>`;
  return { ...config, hotMemory: memoryBlock };
}

// ── Episode recall ───────────────────────────────────────────────────────────

/** Maximum episodes to surface at session start (context-budget guard). */
export const EPISODE_RECALL_CAP = 3;

/**
 * Soft token cap for the <recent-episodes> block injected into the system
 * prompt. Episodes are trimmed from the end (lowest-scored first) until the
 * block fits within this budget.
 */
const EPISODE_TOKEN_CAP = 6_000;

/**
 * Frequency filter threshold: skip files that appear in more than this
 * fraction of all episodes (too common to be a useful signal).
 */
const HIGH_FREQ_THRESHOLD = 0.3;

/**
 * Per-filesKey-prefix eviction cap: when the archive contains more than this
 * many episodes sharing the same leading file path prefix (the first file in
 * the `files:` line, up to the directory component), only the most-recent N
 * are kept as candidates. This bounds the candidate pool at query time —
 * history is preserved in the DB for manual inspection, but scoring pressure
 * is limited so that large archives (200+ sessions) cannot produce guaranteed
 * high-scoring false-positive matches.
 */
const EPISODE_FILES_PREFIX_CAP = 5;

/**
 * Retrieve the current git branch name. Returns null if git is unavailable
 * or the cwd is not a git repository.
 *
 * Item 1: uses execFileSync (array args, no implicit shell) instead of
 * execSync (string command).
 */
/**
 * Validate and canonicalize a cwd before passing to execFileSync.
 * Requires an absolute path and resolves it to eliminate symlinks and
 * `..` segments — on git <2.35.2 an adversary-controlled cwd can
 * trigger RCE via `.git/config` hooks.
 */
function validateCwd(cwd?: string): string {
  const raw = cwd ?? process.cwd();
  if (!isAbsolute(raw)) {
    throw new Error(`cwd must be absolute, got: ${raw}`);
  }
  return resolve(raw);
}

export function getCurrentBranch(cwd?: string): string | null {
  try {
    const safeCwd = validateCwd(cwd);
    const result = execFileSync('git', ['--no-optional-locks', 'rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: safeCwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
    });
    const branch = result.toString().trim();
    return branch.length > 0 && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}

/**
 * Retrieve recently-modified file basenames relative to the upstream default
 * branch. Returns an empty array if git is unavailable or no modified files
 * exist.
 *
 * Item 1: uses execFileSync (no implicit shell).
 * Item 3: detects the default branch dynamically via `git rev-parse
 *   --abbrev-ref origin/HEAD`; falls back to origin/master then origin/main.
 */
export function getRecentlyModifiedFiles(cwd?: string): string[] {
  try {
    const effectiveCwd = validateCwd(cwd);

    // Detect the upstream default branch dynamically.
    let base = 'origin/main'; // final fallback
    try {
      const head = execFileSync('git', ['--no-optional-locks', 'rev-parse', '--abbrev-ref', 'origin/HEAD'], {
        cwd: effectiveCwd,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3_000,
      })
        .toString()
        .trim();
      // `origin/HEAD` resolves to itself when origin/HEAD is not set — skip it.
      if (head.length > 0 && head !== 'origin/HEAD') base = head;
    } catch {
      // origin/HEAD not configured — try origin/master as secondary fallback.
      try {
        execFileSync('git', ['--no-optional-locks', 'rev-parse', '--verify', 'origin/master'], {
          cwd: effectiveCwd,
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 2_000,
        });
        base = 'origin/master';
      } catch {
        // Keep origin/main as the ultimate fallback.
      }
    }

    const result = execFileSync('git', ['--no-optional-locks', 'diff', '--name-only', base], {
      cwd: effectiveCwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    return result
      .toString()
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
  } catch {
    return [];
  }
}

/**
 * Parse the `files:` line from stored episode content and return the file
 * list. Returns an empty array when no `files:` line is present.
 */
export function parseEpisodeFiles(content: string): string[] {
  const match = content.match(/^files:\s*(.+)$/m);
  if (!match || !match[1]) return [];
  return match[1]
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
}

/**
 * Recency decay window in days. Episodes older than this floor out at
 * RECENCY_DECAY_FLOOR rather than reaching zero, so very old but highly
 * relevant episodes can still surface.
 */
const RECENCY_DECAY_DAYS = 90;

/**
 * Minimum recency multiplier (floor). Keeps ancient episodes scoreable but
 * heavily discounted vs. recent ones.
 */
const RECENCY_DECAY_FLOOR = 0.1;

/**
 * Score an episode fact against a set of candidate file paths, an optional
 * branch name, and the episode's age. Higher = more relevant.
 *
 * Scoring (before recency decay):
 *   - +3 per matching full relative path (after high-frequency filter)
 *   - +1 per matching file basename that did NOT already match by full path
 *     (after high-frequency filter); handles episodes that stored abbreviated
 *     paths that don't align with the caller's working-tree paths
 *   - +3 for branch name match (branch episodes are highly contextual)
 *
 * Full-path matches (+3) outweigh basename-only matches (+1) so that
 * `src/utils.ts` and `lib/utils.ts` are disambiguated rather than treated
 * as identical signals. Basename-only matching is kept as a fallback for
 * episodes that stored relative paths that differ from the caller's tree root.
 *
 * The raw score is then multiplied by a linear recency decay over
 * RECENCY_DECAY_DAYS days, floored at RECENCY_DECAY_FLOOR, so stale episodes
 * are deprioritised relative to recent ones without being fully suppressed.
 *
 * Item 4: branch match uses a word-boundary regex so short names like `fix`,
 * `dev`, or `add` do not spuriously match arbitrary episode text.
 */
export function scoreEpisode(
  fact: Fact,
  filePaths: Set<string>,
  branch: string | null,
  highFreqFiles: Set<string>,
): number {
  let score = 0;
  const episodeFiles = parseEpisodeFiles(fact.content);

  // Build a set of basenames derived from the caller's file paths so we can
  // detect basename-only overlaps without double-counting files that already
  // matched by full path.
  const callerBasenames = new Map<string, string[]>();
  for (const p of filePaths) {
    const base = basename(p);
    const list = callerBasenames.get(base) ?? [];
    list.push(p);
    callerBasenames.set(base, list);
  }

  for (const f of episodeFiles) {
    const base = basename(f);
    if (highFreqFiles.has(base)) continue;

    if (filePaths.has(f)) {
      // Full relative-path match — strong signal.
      score += 3;
    } else if (callerBasenames.has(base)) {
      // Basename-only match — weaker signal (possible collision).
      score += 1;
    }
  }

  if (branch) {
    // Require whole-word match: branch name must not be preceded or followed
    // by word characters or path separators ([\w/-]). This prevents short
    // names like `fix`, `dev`, or `add` from matching arbitrary substrings.
    const branchRe = new RegExp(
      `(?<![\\w/-])${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/-])`,
      'i',
    );
    if (branchRe.test(fact.content)) score += 3;
  }

  // Apply linear recency decay so older episodes are deprioritised.
  if (score > 0) {
    const ageDays = (Date.now() - new Date(fact.created_at).getTime()) / 86_400_000;
    const decay = Math.max(RECENCY_DECAY_FLOOR, 1 - ageDays / RECENCY_DECAY_DAYS);
    score *= decay;
  }

  return score;
}

/**
 * Build the set of high-frequency file basenames: those that appear in more
 * than `HIGH_FREQ_THRESHOLD` of the provided episodes. These common files
 * (e.g. `package.json`, `tsconfig.json`) generate too many false-positive
 * matches and are excluded from scoring.
 */
export function buildHighFreqFiles(episodes: Fact[]): Set<string> {
  const total = episodes.length;
  if (total === 0) return new Set();

  const freq = new Map<string, number>();
  for (const ep of episodes) {
    const seen = new Set<string>();
    for (const f of parseEpisodeFiles(ep.content)) {
      const base = basename(f);
      if (!seen.has(base)) {
        seen.add(base);
        freq.set(base, (freq.get(base) ?? 0) + 1);
      }
    }
  }

  const highFreq = new Set<string>();
  for (const [base, count] of freq) {
    if (count / total > HIGH_FREQ_THRESHOLD) highFreq.add(base);
  }
  return highFreq;
}

/**
 * Format a single episode fact for injection into the system prompt.
 * Strips the `[episode:<id>]` prefix line to reduce noise; preserves the
 * remaining structured lines.
 */
export function formatEpisodeForRecall(fact: Fact): string {
  return fact.content
    .split('\n')
    .filter((line) => !line.startsWith('[episode:'))
    .join('\n')
    .trim();
}

/**
 * A scored episode candidate — the episode fact plus its numeric relevance score.
 * Returned by `scoredEpisodes` for inspection (e.g. the `/recall` slash command).
 */
export interface ScoredEpisode {
  ep: Fact;
  score: number;
}

/**
 * Score all episodes against the current git context and return them sorted
 * by descending score. Includes ALL candidates regardless of score (callers
 * decide how to filter).  Useful for the `/recall` inspection command.
 *
 * Errors are swallowed — episode scoring is additive, never critical.
 */
export function scoredEpisodes(memoryDir?: string, cwd?: string, store?: MemoryStore): ScoredEpisode[] {
  const ownsStore = !store;
  const s = store ?? new MemoryStore(memoryDir);
  try {
    const allEpisodes = s.getEpisodes();
    if (allEpisodes.length === 0) return [];

    const branch = getCurrentBranch(cwd);
    const modifiedFiles = getRecentlyModifiedFiles(cwd);
    const filePaths = new Set(modifiedFiles);
    const highFreqFiles = buildHighFreqFiles(allEpisodes);

    // Eviction policy (Item #4682): cap candidates per first-file directory prefix so
    // that large archives (200+ sessions) don't inflate scoring pressure.
    // getEpisodes() returns rows newest-first, so the first
    // EPISODE_FILES_PREFIX_CAP rows for each prefix are the most recent ones —
    // exactly what we want to retain.
    const prefixCount = new Map<string, number>();
    const cappedEpisodes = allEpisodes.filter((ep) => {
      const files = parseEpisodeFiles(ep.content);
      const firstFile = files[0];
      const prefix = firstFile !== undefined
        ? (firstFile.includes('/') ? firstFile.split('/').slice(0, -1).join('/') : firstFile)
        : '';
      const count = (prefixCount.get(prefix) ?? 0) + 1;
      prefixCount.set(prefix, count);
      return count <= EPISODE_FILES_PREFIX_CAP;
    });

    return cappedEpisodes
      .map((ep) => ({
        ep,
        score: scoreEpisode(ep, filePaths, branch, highFreqFiles),
      }))
      .sort((a, b) => b.score - a.score || b.ep.created_at.localeCompare(a.ep.created_at));
  } catch {
    return [];
  } finally {
    if (ownsStore) {
      try { s.close(); } catch { /* best-effort */ }
    }
  }
}

/**
 * Query the memory store for episodes relevant to the current git context
 * (recently-modified files + branch name). Returns up to `EPISODE_RECALL_CAP`
 * scored episodes, or an empty array when none are relevant.
 *
 * Only called when `AFK_EPISODE_RECALL=1`. Errors are swallowed — episode
 * recall is additive and must never block session start.
 *
 * Item 5b: searchFacts is scoped to `source_surface = 'episode-synthesis'`
 *   so access_count is only bumped on episode rows, not on the 200-candidate
 *   pool of unrelated learning facts.
 * Item 7: accepts an optional pre-constructed MemoryStore to avoid opening a
 *   second SQLite handle on the shared DB when the caller already owns one.
 */
export function recallEpisodes(memoryDir?: string, cwd?: string, store?: MemoryStore): Fact[] {
  const all = scoredEpisodes(memoryDir, cwd, store);
  return all
    .filter(({ score }) => score > 0)
    .slice(0, EPISODE_RECALL_CAP)
    .map(({ ep }) => ep);
}

/**
 * Inject relevant past episodes into an AgentConfig as a `<recent-episodes>`
 * block stored in the dedicated `config.episodeRecall` field.
 *
 * Only fires when `AFK_EPISODE_RECALL=1` (opt-in). Skips subagent contexts
 * (`config.parentSessionId` set) — recall is only meaningful for top-level
 * sessions. Returns the config unchanged when no relevant episodes are found.
 *
 * The block is stored in `config.episodeRecall` — a field separate from
 * `config.hotMemory` — so the provider can place it in the volatile tail of
 * the system prompt (after `# Environment`), keeping the stable prefix cache
 * intact across sessions with different episode sets.
 *
 * Does not mutate the original config — returns a shallow copy when changed.
 *
 * Item 2: episode content is sanitized to strip `<recent-episodes>` tags
 *   before joining, preventing structural XML injection into the system prompt.
 * Item 5a: `cwd` defaults to `config.cwd` when not explicitly provided, so
 *   git context is resolved against the session's working directory.
 * Item 6: the assembled block is checked against EPISODE_TOKEN_CAP (~6K
 *   tokens); episodes are trimmed from the end until it fits.
 */
/**
 * Options for {@link injectEpisodeRecall}.
 */
export interface InjectEpisodeRecallOptions {
  /**
   * Per-call suppression override — equivalent to AFK_NO_EPISODE_RECALL=1 for
   * this invocation. Useful for the `--no-recall` CLI flag, which cannot safely
   * write process.env after the env module has been imported. When true the
   * function returns config unchanged regardless of AFK_EPISODE_RECALL.
   */
  noRecall?: boolean;
}

export function injectEpisodeRecall(
  config: AgentConfig,
  memoryDir?: string,
  cwd?: string,
  store?: MemoryStore,
  opts?: InjectEpisodeRecallOptions,
): AgentConfig {
  // Gate: opt-in only (AFK_EPISODE_RECALL=1 or AFK_EPISODE_RECALL=dry-run),
  // and skip subagent forks.
  const recallMode = env.AFK_EPISODE_RECALL;
  const isDryRun = recallMode === 'dry-run';
  if (recallMode !== '1' && !isDryRun) return config;
  if (config.parentSessionId) return config;

  // Per-session suppression: AFK_NO_EPISODE_RECALL=1 or opts.noRecall=true.
  if (env.AFK_NO_EPISODE_RECALL === '1' || opts?.noRecall === true) return config;

  // Item 5a: fall back to session's own cwd when caller doesn't provide one.
  const effectiveCwd = cwd ?? config.cwd;

  const allScored = scoredEpisodes(memoryDir, effectiveCwd, store);
  const positiveScored = allScored.filter(({ score }) => score > 0);
  const episodes = positiveScored.slice(0, EPISODE_RECALL_CAP).map(({ ep }) => ep);
  if (episodes.length === 0) return config;

  debugLog('episode-recall', `injected ${episodes.length} episode(s), cwd=${effectiveCwd ?? 'process.cwd'}`);

  /**
   * Build the <recent-episodes> block from a subset of episodes, applying
   * Item 2 sanitization (strip structural tags) and Item 6 token cap.
   */
  function buildBlock(eps: Fact[]): string {
    // Item 2: strip <recent-episodes> / </recent-episodes> tags (and variants
    // with attributes) from each formatted episode to prevent XML injection.
    const formatted = eps
      .map(formatEpisodeForRecall)
      // Entity-encode < and > to prevent XML injection into the system
      // prompt. A stored fact containing e.g. '</recent-episodes><tool_use>'
      // would otherwise break the prompt XML structure.
      .map((s) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;'))
      .join('\n\n---\n\n');
    return `<recent-episodes>\nThese are compressed narratives from prior sessions. They may be outdated. Verify claims against current file state before relying on them.\n\n${formatted}\n</recent-episodes>`;
  }

  // Item 6: trim episodes from the end until the block fits EPISODE_TOKEN_CAP.
  let capped = episodes.slice();
  let block = buildBlock(capped);
  while (capped.length > 1 && estimateTokens(block) > EPISODE_TOKEN_CAP) {
    capped = capped.slice(0, -1);
    block = buildBlock(capped);
  }

  // dry-run mode: report the post-token-cap list to stderr, then return unchanged.
  if (isDryRun) {
    process.stderr.write(`[episode-recall dry-run] would inject ${capped.length} episode(s) (token-capped from ${positiveScored.length}), cwd=${(effectiveCwd ?? 'process.cwd()').replace(/</g, '&lt;').replace(/>/g, '&gt;')}\n`);
    for (const ep of capped) {
      const rawPreview = formatEpisodeForRecall(ep).split('\n').slice(0, 3).join(' | ');
      const preview = rawPreview.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      process.stderr.write(`  • id=${ep.id} created=${ep.created_at.replace(/</g, '&lt;').replace(/>/g, '&gt;')} — ${preview}\n`);
    }
    return config;
  }

  // Store in dedicated episodeRecall field — NOT appended to hotMemory.
  // The provider assembler places this in the volatile tail (after # Environment)
  // so the stable-prefix cache is never invalidated by per-session episode sets.
  return { ...config, episodeRecall: block };
}
