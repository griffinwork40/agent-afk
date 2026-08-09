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

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { parseSkillMetadata, type PluginSkillMetadata } from './tool-injector.js';

/** Mirrors the depth cap in `extractPluginSkills` — cycle/runaway guard. */
const MAX_DEPTH = 10;

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
  const root = join(pluginPath, 'commands');
  if (!existsSync(root)) return [];

  const out: PluginSkillMetadata[] = [];

  function walk(dir: string, segments: string[], depth: number): void {
    if (depth > MAX_DEPTH) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const full = join(dir, entry);
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
      if (!stat.isFile() || !entry.endsWith('.md')) continue;

      const base = entry.slice(0, -'.md'.length);
      if (base.length === 0) continue;
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
          const content = readFileSync(full, 'utf-8');
          if (!content.startsWith('---\n')) parsed.body = content.trim();
        } catch {
          continue;
        }
      }
      // A command with no readable body is inert — skip rather than register a
      // slash command that would dispatch an empty prompt.
      if (!parsed.body || parsed.body.length === 0) continue;

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
  out.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  return out;
}
