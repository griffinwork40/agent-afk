/**
 * Claude Code `commands/*.md` discovery.
 *
 * Claude Code plugins expose user-invocable prompts through two directories.
 * `skills/<name>/SKILL.md` is the newer form and the one CC steers new authors
 * toward; `commands/<name>.md` is the older one, which CC's docs label "legacy"
 * while guaranteeing continued support with no announced removal. Adoption has
 * not followed the label: a large share of the plugins in Anthropic's own
 * official marketplace ship `commands/` and no `skills/` directory at all, so
 * a loader that reads only SKILL.md silently fails on roughly half of the real
 * ecosystem.
 *
 * The two formats are near-identical — YAML frontmatter plus a markdown prompt
 * body — so a command is discovered here and then travels as an ordinary
 * {@link PluginSkillMetadata} through the same collection, collision, listing,
 * and dispatch machinery SKILL.md already uses. Nothing downstream needs to
 * know a command is a command, except the model-facing manifest (see below).
 *
 * Two things genuinely differ from SKILL.md and are handled here:
 *
 *   1. **The name comes from the PATH, not the frontmatter.** Command files
 *      carry no `name:` field. `commands/deploy.md` is `/deploy`.
 *   2. **Subdirectories are namespaces.** `commands/review/security.md` is
 *      `/review:security`, matching CC, which restored this behaviour in
 *      July 2025 after a period where the nesting was flattened away.
 *
 * Marked `origin: 'command'` so `buildSkillManifest` can keep them out of the
 * model-facing catalogue. That exclusion is deliberate: AFK's manifest has no
 * character budget or eviction policy (CC's does — 1% of the context window,
 * evicting least-used descriptions), so every discovered entry costs prompt
 * tokens on every request forever. Commands are user-invoked slash commands by
 * nature; listing a third-party plugin's whole command surface to the model
 * would grow the system prompt without bound and let the model autonomously
 * fire commands the user never mentioned. They remain fully invocable as
 * `/name` and fully listed by `/skills`.
 *
 * @module agent/plugins/command-files
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'fs';
import { join } from 'path';
import { parseSkillMetadata, type PluginSkillMetadata } from './tool-injector.js';
import { normalizeSkillSource, resolveContained } from './source-guard.js';
import { env } from '../../config/env.js';
// Skip diagnostics interpolate raw `readdirSync` entries from an untrusted
// third-party plugin tree. A directory named with a CSI/OSC sequence would
// otherwise execute against the operator's terminal when AFK_DEBUG is set.
import { sanitizeForDisplay } from '../../utils/terminal-sanitize.js';

/** Mirrors the depth cap in `extractPluginSkills` — cycle/runaway guard. */
const MAX_DEPTH = 10;

/** Breadth cap: bail out of a single plugin walk after this many entries. */
const MAX_ENTRIES = 500;

/**
 * Process-lifetime memoization cache for `extractPluginCommands`, keyed by
 * `pluginPath`. Invalidated by `_resetCommandFilesCache()`, which is called
 * from `_resetPluginScanCache()` on install, uninstall, and `/reload-plugins`.
 */
const commandCache = new Map<string, PluginSkillMetadata[]>();

/**
 * Clear the in-memory command-files cache. Called from `_resetPluginScanCache`
 * so that install/uninstall/reload also invalidates this walker's results.
 */
export function _resetCommandFilesCache(): void {
  commandCache.clear();
}

/**
 * Control bytes — C0, DEL, and C1 — in a path segment.
 *
 * Invariant: a command's name is derived from its file path, so a path segment
 * is the only place a plugin can inject bytes into a name. Unlike a SKILL.md
 * name (frontmatter, i.e. already-normalized file content), this value never
 * passes through `normalizeSkillSource`, so it is validated here instead.
 */
const CONTROL_BYTES = /[\u0000-\u001F\u007F-\u009F]/;

/**
 * `PluginSkillMetadata.name` is typed optional (frontmatter-derived skills
 * may parse without one), but every entry pushed by `extractPluginCommands`
 * below always carries a path-derived name. Narrowing locally lets the sort
 * comparator read `a.name`/`b.name` as `string` without an `as string` cast.
 */
type DiscoveredCommand = PluginSkillMetadata & { name: string };

/**
 * Discover every `*.md` under `<pluginPath>/commands/`.
 *
 * Contract:
 * - Returns `[]` when the plugin ships no `commands/` directory, which is the
 *   common case and must stay cheap.
 * - Name is the path relative to `commands/`, minus the `.md` extension, with
 *   directory separators replaced by `:` — so `review/security.md` yields
 *   `review:security`.
 * - Dotfiles and dot-directories are skipped, matching the SKILL.md walker.
 * - A file that cannot be read or parsed is skipped rather than throwing. One
 *   malformed command in a third-party plugin must not take down discovery for
 *   every other plugin installed.
 * - Results are sorted by name for deterministic ordering, so collision
 *   resolution downstream does not depend on filesystem enumeration order.
 */
export function extractPluginCommands(
  pluginPath: string,
  knownToolNames?: ReadonlySet<string>,
): PluginSkillMetadata[] {
  // Memoize per pluginPath. knownToolNames is caller-supplied context that
  // doesn't change between the two call-sites within a single discovery pass,
  // so keying only on pluginPath is correct. Cache is cleared on install/reload.
  const cached = commandCache.get(pluginPath);
  if (cached !== undefined) return cached;

  const root = join(pluginPath, 'commands');
  if (!existsSync(root)) {
    commandCache.set(pluginPath, []);
    return [];
  }

  // Resolve the containment root's realpath ONCE, before the walk starts, and
  // thread it into every resolveContained call below instead of letting each
  // call re-resolve `root` itself. Re-resolving per-entry (the previous
  // behavior) meant a symlink swapped into `commands/` mid-walk could shift
  // the containment baseline between sibling files. A root that is missing or
  // cannot be resolved behaves exactly as it did before this change: no
  // commands are discovered.
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    commandCache.set(pluginPath, []);
    return [];
  }

  const out: DiscoveredCommand[] = [];
  let entryCount = 0;

  function walk(dir: string, segments: string[], depth: number): void {
    if (depth > MAX_DEPTH) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++entryCount > MAX_ENTRIES) return;
      if (entry.startsWith('.')) {
        if (env.AFK_DEBUG) process.stderr.write(`[afk] skipping dotfile: ${sanitizeForDisplay(join(dir, entry))}\n`);
        continue;
      }
      // A path segment carrying the namespace separator is ambiguous:
      // `commands/a:b.md` and `commands/a/b.md` would both derive `a:b`, and
      // the first-wins guard downstream would silently drop one of them.
      if (entry.includes(':')) {
        if (env.AFK_DEBUG) {
          process.stderr.write(`[afk] skipping path segment with colon: ${sanitizeForDisplay(join(dir, entry))}\n`);
        }
        continue;
      }
      // Reject rather than sanitize, and reject HERE: this is the one point a
      // path segment enters a name (as a `segments` entry below, or as `base`),
      // so a single guard covers every name this walk can produce. The name is
      // later written to the terminal unsanitized by the `/skills` listing and
      // by the shadowing notice — which fires without the user asking for it —
      // and sanitizing those render sites would leave the next one unguarded.
      // A control byte in a plugin-supplied filename is never a legitimate
      // command name, so failing closed costs nothing.
      if (CONTROL_BYTES.test(entry)) {
        if (env.AFK_DEBUG) {
          process.stderr.write(
            `[afk] skipping path segment with control bytes: ${sanitizeForDisplay(join(dir, entry))}\n`,
          );
        }
        continue;
      }
      const full = join(dir, entry);
      // Skip anything resolving outside the commands/ tree — a symlinked
      // `help.md -> ~/.ssh/id_rsa` must never become a dispatchable prompt.
      if (resolveContained(root, full, realRoot) === undefined) {
        if (env.AFK_DEBUG) {
          process.stderr.write(`[afk] skipping path outside commands/ tree: ${sanitizeForDisplay(full)}\n`);
        }
        continue;
      }
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full, [...segments, entry], depth + 1);
        continue;
      }
      if (!stat.isFile() || !entry.endsWith('.md')) {
        if (env.AFK_DEBUG) process.stderr.write(`[afk] skipping non-markdown entry: ${sanitizeForDisplay(full)}\n`);
        continue;
      }

      const base = entry.slice(0, -'.md'.length);
      if (base.length === 0) {
        if (env.AFK_DEBUG) {
          process.stderr.write(`[afk] skipping command with empty basename: ${sanitizeForDisplay(full)}\n`);
        }
        continue;
      }
      const name = [...segments, base].join(':');

      // Reuse the SKILL.md frontmatter parser verbatim: the fields a command
      // declares (description, argument-hint, allowed-tools, model) are a
      // subset of what it already understands, and sharing it means a command
      // and a skill can never drift in how identical frontmatter is read.
      const parsed = parseSkillMetadata(full, knownToolNames);
      // Unlike SKILL.md, command frontmatter is optional. The shared parser
      // deliberately rejects files without it, so preserve a plain Markdown
      // prompt as the body while continuing to reject malformed frontmatter.
      if (!parsed.body) {
        try {
          const content = normalizeSkillSource(readFileSync(full, 'utf-8'));
          if (!content.startsWith('---\n')) parsed.body = content.trim();
        } catch {
          continue;
        }
      }
      // A command with no readable body is inert — skip rather than register a
      // slash command that would dispatch an empty prompt.
      if (!parsed.body || parsed.body.length === 0) {
        if (env.AFK_DEBUG) process.stderr.write(`[afk] skipping command with empty body: ${sanitizeForDisplay(full)}\n`);
        continue;
      }

      out.push({
        ...parsed,
        // Path-derived name always wins. A stray `name:` in a command file is
        // not how CC addresses it, so honouring it would make the file
        // invocable under a name its own path does not predict.
        name,
        origin: 'command',
      });
    }
  }

  walk(root, [], 0);
  // Codepoint order, not localeCompare: ICU collation varies by locale and
  // build, and this ordering is what makes collision resolution reproducible.
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  commandCache.set(pluginPath, out);
  return out;
}
