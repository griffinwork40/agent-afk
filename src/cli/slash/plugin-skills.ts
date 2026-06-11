/**
 * Plugin-skill bridge + unified `/skills` listing.
 *
 * This module owns two responsibilities:
 *
 *   1. Bridging plugin-discovered skills (from `~/.afk/plugins/.../SKILL.md`)
 *      into the slash dispatcher. Each becomes a passthrough handler that
 *      returns `'forward'`, so the REPL pipes the raw `/skill args` line back
 *      into the normal turn loop unchanged — the SDK runtime knows how to
 *      dispatch plugin skills natively.
 *
 *   2. Rendering `/skills`, the single canonical listing of every skill
 *      available in this session — vendored TS skills, user-authored
 *      `~/.afk/skills/` skills, and plugin skills, all under one header.
 *      `/builtin-skills` exists as an alias for back-compat with prior tests
 *      and muscle memory.
 *
 * Vendored wins on bare-name collision: when a plugin (or user) skill shares
 * a bare name with a vendored skill, the plugin/user version is reachable
 * only via its namespaced form (e.g. `/example-plugin:mint`, `/user:mint`),
 * never under the bare `/mint`. The unified listing surfaces shadowed alts as
 * continuation rows under the winning entry; on REPL boot we print a one-time
 * dim notice for each collision so users aren't surprised.
 *
 * Flow:
 *   1. `registerStaticPluginSkillCommands()` installs the placeholder
 *      `/skills` (also reachable as `/builtin-skills`) at REPL boot — the
 *      session isn't up yet, so plugin discovery is empty but the registry
 *      already has vendored + user skills, which the placeholder can list.
 *   2. After `session.waitForInitialization()` resolves,
 *      `registerPluginSkills(session)` calls `session.supportedCommands()`,
 *      registers passthrough handlers for non-colliding plugin skills, and
 *      hot-swaps `/skills` to render the live merged list.
 *   3. `/reload-plugins` re-runs the query after the user edits SKILL.md
 *      files on disk.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import type { AgentSession } from '../../agent/session.js';
import { _resetPluginScanCache } from '../../agent/plugins-scanner.js';
import { collectSkillEntries, type SkillManifestEntry } from '../../agent/tools/skill-bridge.js';
import {
  listInstalledPlugins,
  formatPluginVersion,
  type InstalledPlugin,
} from '../../agent/plugins/inventory.js';
import { getMarketplaceCacheDir, getBundledPluginsDir } from '../../paths.js';
import { listSkills, getSkill, isSkillVisible, listVisibleSkills, type SkillMetadata } from '../../skills/index.js';
import { palette } from '../palette.js';
import { divider } from '../render.js';
import { wrapToWidth } from '../wrap.js';
import { getTerminalWidth } from '../terminal-size.js';
import { padDisplayRight, displayWidth } from '../display.js';
import { registerPluginAgents } from './plugin-agents.js';
import { registerOrReplace, register } from './registry.js';
import { harvestFlagsFromSkillMd } from './_lib/flag-harvest.js';
import { runSkillDispatchTurn } from './_lib/run-skill-dispatch-turn.js';
import { parsePostFlag, runReviewPostPublish, type PostTarget } from './_lib/review-post.js';
import { parsePrRef } from './preflight/review-pr.js';
import {
  runPreflight,
  getSkillPreflightDir,
  type SkillInvocation,
} from './preflight/index.js';
import { env } from '../../config/env.js';
import type { SlashCommand, SlashContext, SlashResult } from './types.js';
import type { ImageAttachment } from '../input/attachments.js';

const CORE_COMMANDS = new Set(['/exit', '/quit', '/clear', '/compact', '/help']);

interface DiscoveredSkill {
  /** Name as reported by `session.supportedCommands()` — may include a `<plugin>:` namespace. */
  name: string;
  description: string;
  argumentHint?: string;
}

/** Track collisions detected at registration time so /skills can render alts and boot can notify. */
interface PluginCollision {
  /** Bare name shared between vendored/user winner and the plugin alt. */
  bare: string;
  /** Slash form of the surviving plugin alt (e.g. `/example-plugin:mint`). */
  altSlash: string;
  /** Description from the plugin side, for the alt continuation row. */
  altDescription: string;
}

interface PluginSkillsState {
  discovered: DiscoveredSkill[];
  collisions: PluginCollision[];
  /** Set of bare names whose plugin form was registered under a fallback (collision). */
  shadowedBareNames: Set<string>;
}

let state: PluginSkillsState = {
  discovered: [],
  collisions: [],
  shadowedBareNames: new Set(),
};

/** Strip the `<plugin>:` namespace prefix from a skill name. */
function bareName(name: string): string {
  return name.includes(':') ? name.split(':').pop()! : name;
}

/**
 * Walk the plugin cache directory tree and harvest flags from SKILL.md files.
 *
 * Kept as a public export because tests and other callers import it directly.
 * Internally delegates to the shared parser in `_lib/flag-harvest.ts` so the
 * user surface and plugin surface use identical extraction rules.
 *
 * @returns A map from skill name (directory name) to sorted array of flags.
 */
export function harvestPluginSkillFlags(cacheRoot?: string): Map<string, string[]> {
  const root = cacheRoot ?? getMarketplaceCacheDir();
  const result = new Map<string, string[]>();

  try {
    statSync(root);
  } catch {
    return result;
  }

  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;

    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);

      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath, depth + 1);
        continue;
      }
      if (entry !== 'SKILL.md' || !stat.isFile()) continue;

      let content;
      try {
        content = readFileSync(fullPath, 'utf-8');
      } catch {
        continue;
      }

      const pathParts = fullPath.split('/');
      const skillName = pathParts[pathParts.length - 2];
      if (!skillName) continue;

      const flags = harvestFlagsFromSkillMd(content);

      if (flags.length === 0) continue;

      const existing = result.get(skillName) ?? [];
      const merged = new Set([...existing, ...flags]);
      result.set(skillName, Array.from(merged).sort());
    }
  };

  walk(root, 0);
  return result;
}

/**
 * Harvest flags from BOTH the marketplace cache AND the bundled-plugins dir,
 * merging per-skill (union, deduped, sorted).
 *
 * Why both: `session.supportedCommands()` surfaces bundled skills (e.g. the
 * `awa-bundled` /review), but a plugin skill's flags live only in its SKILL.md
 * and the plain `harvestPluginSkillFlags()` walks only the cache. Without the
 * bundled-dir pass, a bundled-only skill gets NO flag completion in the
 * dropdown even though its argument-hint declares flags. Walking both keeps the
 * completion set consistent regardless of whether a skill is installed
 * (cache) or shipped (bundled).
 */
function harvestAllPluginSkillFlags(): Map<string, string[]> {
  const merged = harvestPluginSkillFlags();
  for (const [name, flags] of harvestPluginSkillFlags(getBundledPluginsDir())) {
    const existing = merged.get(name) ?? [];
    merged.set(name, Array.from(new Set([...existing, ...flags])).sort());
  }
  return merged;
}

/**
 * Best-effort "when to use" extraction from a plugin SKILL.md description.
 *
 * Plugin skills don't carry a structured `whenToUse` field — the convention
 * encoded in nearly every shipped SKILL.md is to embed a "Use when …" /
 * "When to use …" sentence inside the description. Pluck it out so the
 * dropdown tooltip can surface real guidance instead of repeating the
 * one-liner the dropdown summary already shows.
 *
 * Falls back to `undefined` when no such sentence is detectable. The tooltip
 * row collapses cleanly in that case.
 */
export function extractHintFromDescription(description: string): string | undefined {
  if (!description) return undefined;
  // Split on sentence terminators (`. `, `! `, `? `) while keeping the
  // sentences. Simple — descriptions are short, and any false-positive split
  // just truncates the hint, never breaks the tooltip.
  const sentences = description.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    const m = /^(Use(?:d)? when\b.*|When\s+(?:the\s+user\s+|to\s+)?\b.*)$/i.exec(sentence.trim());
    if (m && m[1]) {
      const hint = m[1].trim();
      // Discard pathological short matches like "When." that survive splitting.
      if (hint.length >= 12) return hint;
    }
  }
  return undefined;
}

/**
 * Build the dispatch handler for a single plugin skill.
 *
 * Exported for regression tests that exercise the symmetric `runPreflight`
 * extension (the production path goes through `registerPluginSkills` →
 * `registerOrReplace`, but tests want to invoke the handler directly with a
 * synthetic `DiscoveredSkill`).
 */
export function makeForwardHandler(skill: DiscoveredSkill, flags?: readonly string[]): SlashCommand {
  const slashName = `/${skill.name}`;
  const usage = skill.argumentHint ? `${slashName} ${skill.argumentHint}` : undefined;
  const hint = extractHintFromDescription(skill.description);
  return {
    name: slashName,
    summary: skill.description,
    // Image-tail parity with `makeImmediateHandler`. Plugin skills go
    // through the same `buildSkillInvocationMessage` encoder, which
    // appends image blocks after the breadcrumb + instruction tail —
    // without `acceptsAttachments: true` the registry would warn and
    // drop attachments before the handler ever ran. See registry.ts.
    acceptsAttachments: true,
    ...(usage !== undefined ? { usage } : {}),
    ...(hint ? { hint } : {}),
    ...(flags && flags.length > 0 ? { flags } : {}),
    async handler(
      ctx: SlashContext,
      args: string,
      attachments?: readonly ImageAttachment[],
    ): Promise<SlashResult> {
      // `/review --post <github|telegram>` — parsed here at the dispatch layer
      // and stripped from the args BEFORE they reach the (read-only) review
      // skill, so the skill never sees `--post` as a review target and never
      // posts anything itself. Publishing happens after the verified output
      // lands (see runReviewPostPublish, below). Gated on the bare name so the
      // flag is review-only; every other plugin skill is unaffected.
      const isReview = bareName(skill.name) === 'review';
      let dispatchArgs = args;
      let postTargets: PostTarget[] = [];
      let prRefFromArgs: string | null = null;
      if (isReview) {
        const parsed = parsePostFlag(args);
        postTargets = parsed.targets;
        dispatchArgs = parsed.cleanedArgs;
        for (const u of parsed.unknown) {
          ctx.out.warn(`/review: unknown --post target "${u}" — expected "github" or "telegram".`);
        }
        if (postTargets.length === 0 && parsed.unknown.length === 0 && /--post\b/.test(args)) {
          ctx.out.warn('/review: --post needs a target — try "--post github" or "--post telegram".');
        }
        // Reuse the preflight's PR-ref parser so `/review 277 --post github`
        // comments on PR 277; a local-diff review (no PR ref) resolves the
        // current branch's PR at publish time instead.
        try {
          prRefFromArgs = parsePrRef(dispatchArgs);
        } catch {
          prRefFromArgs = null;
        }
      }

      // Mirror makeImmediateHandler: build the 2-block skill-invocation payload
      // (breadcrumb + dispatch instruction) and stream it through the session,
      // rather than returning 'forward' and letting the REPL send raw '/skill'
      // text. The raw-text path caused the model to invoke the skill with no
      // context, triggering a 2s no-op before the model manually re-invoked.
      //
      // Plugin skills don't have a SkillMetadata handler or context field.
      // buildSkillInvocationMessage only reads .name and .context, so we
      // synthesise a minimal adapter — context defaults to 'inline' (no fork note).
      const skillMeta: SkillMetadata = {
        name: skill.name,
        description: skill.description,
        // Plugin skills run via the skill tool's plugin executor — no local handler.
        handler: async () => undefined,
        // Plugin skills are always inline from the slash-dispatch perspective;
        // the executor inside the session handles any fork context internally.
        context: 'inline',
      };

      try {
        const finalAssistantText = await runSkillDispatchTurn(ctx, {
          skillName: skill.name,
          skillMeta,
          args: dispatchArgs,
          attachments,
          // SkillPreflight — runtime-owned context gathering, runs inside
          // the armed renderer. Symmetric with makeImmediateHandler
          // (built-in path): registered preflights produce a manifest
          // block prepended as additive context; the breadcrumb +
          // instruction tail stays bit-for-bit identical so the `skill`-
          // tool dispatch the model recognizes is preserved.
          //
          // Lookup key is the *bare* skill name (no `<plugin>:` prefix) so
          // a single registered preflight covers every source
          // (builtin/user/project/plugin) for the same skill name. This
          // matches the registry lookup in repl-loop.ts.
          //
          // Failure isolation: preflight throws or returns null → falls
          // through to the standard 2-block dispatch unchanged. A failing
          // context-gather must never block a skill from running.
          preflight: async (): Promise<string | undefined> => {
            const bareSkillName = skill.name.includes(':')
              ? (skill.name.split(':').pop() ?? skill.name)
              : skill.name;
            const inv: SkillInvocation = {
              skillName: bareSkillName,
              rawArgs: dispatchArgs,
              source: 'plugin',
              capabilities: { compose: true, subagents: true },
            };
            const sessionIdMaybe = ctx.session.current.sessionId;
            const artifactDir = getSkillPreflightDir(sessionIdMaybe);
            const preflightResult = await runPreflight(
              inv,
              // Honor the session's effective cwd so preflights that shell
              // out to `git status` / file globs operate on the worktree,
              // not the Node host's process.cwd() (the parent repo when
              // launched with `afk i --worktree`). `stats.cwd` is stamped
              // at bootstrap.ts:328 with the same `process.cwd()` fallback.
              { cwd: ctx.stats.cwd ?? process.cwd(), artifactDir },
              (err) => {
                if (env.AFK_SKILL_STREAM_VERBOSE === '1') {
                  ctx.out.warn(`preflight(${bareSkillName}) failed: ${err instanceof Error ? err.message : String(err)}`);
                }
              },
            );
            return preflightResult?.manifestBlock;
          },
        });

        // Publish AFTER the verified review output lands. runReviewPostPublish
        // is fail-soft — it never throws and never suppresses the stdout the
        // renderer already streamed, so a posting failure can't be mistaken
        // for a review failure in the catch below.
        if (isReview && postTargets.length > 0) {
          await runReviewPostPublish(ctx.out, {
            targets: postTargets,
            reviewText: finalAssistantText,
            prRefFromArgs,
          });
        }
      } catch (err) {
        ctx.out.line();
        ctx.out.error(
          `${skill.name} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return 'continue';
    },
  };
}

/** Where a listing row's skill came from. Drives the friendly source label. */
type SkillSource = 'builtin' | 'user' | 'project' | 'plugin';

/** A row in the unified `/skills` listing. */
interface ListingRow {
  /** Slash form for tab-completion / invocation, e.g. `/mint` or `/example-plugin:mint`. */
  slashName: string;
  /** Display form preferred when present, e.g. `/mint <idea>` or `/forge [--brief]`. */
  display: string;
  description: string;
  /** Origin of the skill — surfaced as a friendly source label, never a raw badge. */
  source: SkillSource;
}

interface ListingGroup {
  main: ListingRow;
  alts: ListingRow[];
}

/** Map a registry skill's `origin` (absent = vendored) to a listing source. */
function registryOriginToSource(origin: SkillMetadata['origin']): SkillSource {
  if (origin === 'user') return 'user';
  if (origin === 'project') return 'project';
  return 'builtin';
}

function buildListingGroups(plugins: DiscoveredSkill[], internalUnlocked: boolean): Map<string, ListingGroup> {
  const groups = new Map<string, ListingGroup>();

  const addRow = (row: ListingRow): void => {
    const key = bareName(row.slashName.replace(/^\//, ''));
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { main: row, alts: [] });
    } else {
      existing.alts.push(row);
    }
  };

  // Pass 1: registry skills (vendored + user + project). Names already account
  // for collision (user-skills.ts shifts colliding names to `<origin>:<name>`),
  // so a `user:mint` lands as an alt under the vendored `mint` via addRow's
  // bare-name keying.
  for (const name of listVisibleSkills(internalUnlocked)) {
    const skill = getSkill(name);
    const slashName = `/${name}`;
    const display = skill.argumentHint
      ? `${slashName} ${skill.argumentHint}`
      : slashName;
    addRow({
      slashName,
      display,
      description: skill.description,
      source: registryOriginToSource(skill.origin),
    });
  }

  // Pass 2: plugin skills. Group by bare name so a colliding plugin entry
  // becomes an alt under the vendored/user winner. For shadowed plugins,
  // surface the namespaced fallback slash (e.g. `/plugin:mint`) — that's the
  // actually-invokable form, not the bare `/mint` (which now points at the
  // vendored handler).
  const altSlashByBare = new Map(state.collisions.map((c) => [c.bare, c.altSlash]));

  for (const skill of plugins) {
    const bare = bareName(skill.name);
    const altSlash = altSlashByBare.get(bare);
    const slashName = altSlash ?? `/${skill.name}`;
    const display = skill.argumentHint
      ? `${slashName} ${skill.argumentHint}`
      : slashName;
    addRow({
      slashName,
      display,
      description: skill.description,
      source: 'plugin',
    });
  }

  return groups;
}

/** Human-friendly source label — replaces the old raw `(user)`/`(plugin)` badges. */
function friendlySource(source: SkillSource): string {
  switch (source) {
    case 'builtin':
      return 'built-in';
    case 'user':
      return 'user';
    case 'project':
      return 'project';
    case 'plugin':
      return 'plugin';
  }
}

/** Sort comparator: alphabetical by bare skill name. */
function byBareName(a: ListingGroup, b: ListingGroup): number {
  const an = bareName(a.main.slashName.replace(/^\//, ''));
  const bn = bareName(b.main.slashName.replace(/^\//, ''));
  return an.localeCompare(bn);
}

/**
 * Render one skill as a wrapped two-column row: padded name on the left, the
 * word-wrapped description on the right (continuation lines hang under the
 * description column). When a name is too wide for the gutter it takes its own
 * line. Shadowed/alternative forms render as a dim `↳ also:` continuation line
 * — visible by default, never hidden behind a flag.
 */
function renderGroupRows(
  ctx: SlashContext,
  group: ListingGroup,
  nameW: number,
  descW: number,
): void {
  const { main, alts } = group;
  const wrapped = wrapToWidth(main.description, descW).split('\n');

  if (displayWidth(main.display) > nameW - 1) {
    // Name too wide for the gutter — give it its own line, hang the description.
    ctx.out.line('  ' + palette.warning(main.display));
    for (const line of wrapped) {
      ctx.out.line('  ' + ' '.repeat(nameW) + palette.dim(line));
    }
  } else {
    const paddedName = padDisplayRight(palette.warning(main.display), nameW);
    ctx.out.line('  ' + paddedName + palette.dim(wrapped[0] ?? ''));
    for (const extra of wrapped.slice(1)) {
      ctx.out.line('  ' + ' '.repeat(nameW) + palette.dim(extra));
    }
  }

  if (alts.length > 0) {
    const altForms = alts.map((a) => a.slashName).join(', ');
    for (const altLine of wrapToWidth(`↳ also: ${altForms}`, descW).split('\n')) {
      ctx.out.line('  ' + ' '.repeat(nameW) + palette.dim(altLine));
    }
  }
}

function renderUnifiedListing(ctx: SlashContext, plugins: DiscoveredSkill[], internalUnlocked: boolean): void {
  const groups = buildListingGroups(plugins, internalUnlocked);

  ctx.out.line();
  if (groups.size === 0) {
    ctx.out.line(palette.dim('  No skills available. Built-in skills should always load — check your install.'));
    ctx.out.line();
    return;
  }

  const allGroups = Array.from(groups.values());
  const altCount = allGroups.reduce((n, g) => n + g.alts.length, 0);

  // Built-in skills carry the richest metadata and are the modal starting
  // point, so they get their own block at the top. Everything else (user,
  // project, plugin) follows in a second block. Within each, alphabetical.
  const builtinGroups = allGroups.filter((g) => g.main.source === 'builtin').sort(byBareName);
  const otherGroups = allGroups.filter((g) => g.main.source !== 'builtin').sort(byBareName);

  // Column widths mirror the help-table layout: name column capped at ~45% of
  // the terminal, the rest for the wrapped description. Width-aware so narrow
  // terminals stay readable.
  const termW = Math.max(20, getTerminalWidth());
  const maxDisplay = allGroups.reduce((m, g) => Math.max(m, displayWidth(g.main.display)), 0);
  const nameW = Math.min(maxDisplay + 2, Math.max(10, Math.floor((termW - 2) * 0.45)));
  const descW = Math.max(12, termW - 2 - nameW);

  // Header + a one-line source legend listing only the sources actually present.
  ctx.out.line(palette.bold('Skills') + palette.dim(`  (${allGroups.length})`));
  const present = new Set(allGroups.map((g) => g.main.source));
  const legend = (['builtin', 'user', 'project', 'plugin'] as const)
    .filter((s) => present.has(s))
    .map(friendlySource)
    .join(' · ');
  ctx.out.line(palette.dim(`  ${legend} — /skills <name> for details`));

  if (builtinGroups.length > 0) {
    ctx.out.line();
    ctx.out.line(divider('Built-in'));
    for (const g of builtinGroups) renderGroupRows(ctx, g, nameW, descW);
  }
  if (otherGroups.length > 0) {
    ctx.out.line();
    ctx.out.line(builtinGroups.length > 0 ? divider('Plugins & user skills') : divider());
    for (const g of otherGroups) renderGroupRows(ctx, g, nameW, descW);
  }

  ctx.out.line();
  ctx.out.line(
    palette.dim(
      altCount > 0
        ? '  Tip: ↳ also lines show alternative (shadowed) forms · /skills <name> for full details'
        : '  Tip: /skills <name> for full details on a skill',
    ),
  );
  ctx.out.line();
}

function tryGetRegistrySkill(
  name: string,
  internalUnlocked: boolean,
): SkillMetadata | undefined {
  try {
    const skill = getSkill(name);
    return isSkillVisible(skill, internalUnlocked) ? skill : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Collect the shadowed/alternative forms of a bare skill name — namespaced
 * registry collisions (`user:`/`project:`) plus shadowed plugin entries. These
 * are surfaced (not hidden) so a user always knows an alternative exists.
 */
function collectAlternatives(
  bare: string,
  internalUnlocked: boolean,
): Array<{ slash: string; source: SkillSource }> {
  const alternatives: Array<{ slash: string; source: SkillSource }> = [];

  for (const name of listVisibleSkills(internalUnlocked)) {
    if (name.includes(':') && bareName(name) === bare) {
      const source = registryOriginToSource(getSkill(name).origin);
      alternatives.push({ slash: `/${name}`, source });
    }
  }
  for (const collision of state.collisions) {
    if (collision.bare === bare) {
      alternatives.push({ slash: collision.altSlash, source: 'plugin' });
    }
  }
  return alternatives;
}

function renderSkillDetail(
  ctx: SlashContext,
  query: string,
  plugins: DiscoveredSkill[],
  internalUnlocked: boolean,
): void {
  const cleaned = query.replace(/^\//, '').trim();

  const registrySkill = tryGetRegistrySkill(cleaned, internalUnlocked);
  const pluginSkill = plugins.find(
    (p) => bareName(p.name) === cleaned || p.name === cleaned,
  );

  if (!registrySkill && !pluginSkill) {
    ctx.out.line();
    ctx.out.line(palette.dim(`  No skill found matching "${cleaned}".`));
    ctx.out.line(palette.dim('  Run /skills to see everything available.'));
    ctx.out.line();
    return;
  }

  const name = registrySkill?.name ?? bareName(pluginSkill!.name);
  const description = registrySkill?.description ?? pluginSkill!.description;
  const hint = registrySkill?.argumentHint ?? pluginSkill?.argumentHint;
  const displayName = hint ? `/${name} ${hint}` : `/${name}`;
  const source: SkillSource = registrySkill
    ? registryOriginToSource(registrySkill.origin)
    : 'plugin';

  // Wrap the body to the terminal width (capped) so long descriptions read as
  // paragraphs instead of one runaway line.
  const termW = Math.max(20, getTerminalWidth());
  const bodyW = Math.max(20, Math.min(termW - 2, 100));

  ctx.out.line();
  ctx.out.line(`  ${palette.warning(displayName)}`);
  ctx.out.line();
  for (const line of wrapToWidth(description, bodyW).split('\n')) {
    ctx.out.line(`  ${line}`);
  }

  // "When to use": structured field for vendored skills; for plugin/user skills
  // fall back to plucking a "Use when…" sentence out of the description. Skip
  // when it would merely echo the description verbatim.
  const whenToUse = registrySkill?.whenToUse ?? extractHintFromDescription(description);
  if (whenToUse && whenToUse !== description.trim()) {
    ctx.out.line();
    ctx.out.line(`  ${palette.bold('When to use')}`);
    for (const line of wrapToWidth(whenToUse, bodyW).split('\n')) {
      ctx.out.line(`  ${palette.dim(line)}`);
    }
  }

  const flags = registrySkill?.flags ?? harvestAllPluginSkillFlags().get(cleaned);
  if (flags && flags.length > 0) {
    ctx.out.line();
    ctx.out.line(`  ${palette.bold('Flags')}  ${palette.dim(flags.join(', '))}`);
  }

  ctx.out.line();
  ctx.out.line(`  ${palette.bold('Source')}  ${palette.dim(friendlySource(source))}`);

  const alternatives = collectAlternatives(name, internalUnlocked);
  if (alternatives.length > 0) {
    ctx.out.line();
    ctx.out.line(`  ${palette.bold('Alternatives')}`);
    for (const alt of alternatives) {
      ctx.out.line(
        `  ${palette.dim('↳')} ${palette.warning(alt.slash)} ${palette.dim(
          `(${friendlySource(alt.source)} — shadowed by /${name})`,
        )}`,
      );
    }
  }

  ctx.out.line();
}

/**
 * Placeholder `/skills` installed at REPL boot — before the SDK session is
 * up, plugin discovery hasn't run, so we render only registry skills (which
 * are populated synchronously at module load + `registerBuiltinSkillCommands`).
 * The listing replaces this once `registerPluginSkills()` runs after init.
 */
export const initialSkillsCmd: SlashCommand = {
  name: '/skills',
  aliases: ['/builtin-skills'],
  summary: 'List all skills available in this session — vendored, user, and plugin',
  usage: '/skills [name]',
  hint: 'When you want to browse every skill the session can dispatch — pass a name for full details on one.',
  async handler(ctx, args) {
    const internalUnlocked = env.AFK_INTERNAL === '1';
    const trimmed = args.trim();
    // A leading-dash token (e.g. `--all`) is reserved for future verbose modes;
    // for now it just renders the full listing rather than 404 as a skill name.
    if (trimmed && !trimmed.startsWith('-')) {
      renderSkillDetail(ctx, trimmed, [], internalUnlocked);
    } else {
      renderUnifiedListing(ctx, [], internalUnlocked);
    }
    return 'continue';
  },
};

/** Render the live `/skills` listing once plugin skills have been discovered. */
function makeDynamicSkillsCmd(plugins: DiscoveredSkill[]): SlashCommand {
  return {
    name: '/skills',
    aliases: ['/builtin-skills'],
    summary: 'List all skills available in this session — vendored, user, and plugin',
    usage: '/skills [name]',
    hint: 'When you want to browse every skill the session can dispatch — pass a name for full details on one.',
    async handler(ctx, args) {
      const internalUnlocked = env.AFK_INTERNAL === '1';
      const trimmed = args.trim();
      // A leading-dash token (e.g. `--all`) is reserved for future verbose
      // modes; for now it renders the full listing rather than 404 as a name.
      if (trimmed && !trimmed.startsWith('-')) {
        renderSkillDetail(ctx, trimmed, plugins, internalUnlocked);
      } else {
        renderUnifiedListing(ctx, plugins, internalUnlocked);
      }
      return 'continue';
    },
  };
}

/**
 * Query the current session for loaded plugin skills and register each as a
 * passthrough slash command. Vendored and user skills already in the global
 * skill registry win bare-name collisions — colliding plugin skills are still
 * reachable via their namespaced form, and surface as alt rows in `/skills`.
 *
 * Safe to call repeatedly — re-registration replaces prior plugin entries.
 *
 * @returns the discovered skill count, or null if the query failed.
 */
export async function registerPluginSkills(
  session: AgentSession,
): Promise<number | null> {
  let commands;
  try {
    commands = await session.supportedCommands();
  } catch (err) {
    // Non-fatal — plugin skills are nice-to-have; the REPL works without them.
    // eslint-disable-next-line no-console
    console.error(
      palette.dim('  ⚠ Plugin-skill discovery failed: ') +
        (err instanceof Error ? err.message : String(err)),
    );
    return null;
  }

  const discovered: DiscoveredSkill[] = commands.map((c) => ({
    name: c.name,
    description: c.description,
    ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
  }));

  const harvestedFlags = harvestAllPluginSkillFlags();
  // Reserved names = registry skills that are ACTUALLY VISIBLE at the
  // current tier. Internal-tier skills (forge, audit-fit) that are hidden
  // by the audience gate don't reserve their slash — otherwise a plugin
  // contributing `forge` would be pushed to /plugin:forge even though no
  // visible bare /forge exists, leaving the user with a confusing
  // namespace prefix for a slot that's effectively empty.
  const internalUnlocked = env.AFK_INTERNAL === '1';
  const reservedBareNames = new Set(
    listSkills()
      .filter((name) => isSkillVisible(getSkill(name), internalUnlocked))
      .map(bareName),
  );

  const collisions: PluginCollision[] = [];
  const shadowedBareNames = new Set<string>();

  for (const skill of discovered) {
    const slashName = `/${skill.name}`;
    if (CORE_COMMANDS.has(slashName)) continue;

    const bare = bareName(skill.name);
    const flags = harvestedFlags.get(bare);

    if (reservedBareNames.has(bare)) {
      // Vendored or user skill already owns the bare slot. Register only the
      // namespaced form so the plugin skill is still reachable. If the SDK
      // gave us a bare name with no namespace, synthesise one.
      const fallbackName = skill.name.includes(':') ? skill.name : `plugin:${skill.name}`;
      const fallbackSkill: DiscoveredSkill = { ...skill, name: fallbackName };
      registerOrReplace(makeForwardHandler(fallbackSkill, flags));
      collisions.push({
        bare,
        altSlash: `/${fallbackName}`,
        altDescription: skill.description,
      });
      shadowedBareNames.add(bare);
      continue;
    }

    // No collision — register at the SDK-given name (which may already be
    // namespaced like `example-plugin:mint`).
    registerOrReplace(makeForwardHandler(skill, flags));
  }

  state = { discovered, collisions, shadowedBareNames };
  registerOrReplace(makeDynamicSkillsCmd(discovered));

  return discovered.length;
}

/**
 * Return a one-time dim notice line for each detected plugin shadowing. The
 * REPL post-init wiring captures the result and prints it at the top of the
 * next prompt iteration, so the user sees which plugins got shadowed without
 * extra interaction. Returns an empty array when nothing was shadowed.
 */
export function getPluginShadowingNoticeLines(): string[] {
  if (state.collisions.length === 0) return [];
  return state.collisions.map((c) =>
    palette.dim(
      `  /${c.bare}: vendored or user skill wins; plugin form ${c.altSlash} stays reachable.`,
    ),
  );
}

/**
 * Post-init wiring helper. Called by the REPL once `waitForInitialization()`
 * resolves so users don't have to run `/reload-plugins` manually at every
 * startup. Mirrors the registration half of `/reload-plugins` — skipping the
 * query-side `reloadPlugins()` call, which is unnecessary on a fresh session
 * (the subprocess already scanned plugin dirs during boot).
 *
 * Errors inside `registerPluginSkills` / `registerPluginAgents` are already
 * caught and logged in those functions (returning `null`), so this helper
 * is non-throwing in practice — the REPL stays usable even when discovery
 * fails.
 */
export async function autoRegisterPluginPassthroughs(
  session: AgentSession,
): Promise<{ skillCount: number | null; agentCount: number | null }> {
  const [skillCount, agentCount] = await Promise.all([
    registerPluginSkills(session),
    registerPluginAgents(session),
  ]);
  return { skillCount, agentCount };
}

/**
 * Build the dim "source breakdown" segment for the reload summary, e.g.
 * `38 built-in · 12 plugin · 2 user`. Only non-zero sources appear, in a fixed
 * order. Returns '' when there are no skills to break down.
 */
export function buildSourceBreakdown(entries: SkillManifestEntry[]): string {
  const counts: Record<SkillManifestEntry['source'], number> = {
    builtin: 0,
    plugin: 0,
    user: 0,
    project: 0,
  };
  for (const e of entries) counts[e.source]++;
  const labels: Array<[SkillManifestEntry['source'], string]> = [
    ['builtin', 'built-in'],
    ['plugin', 'plugin'],
    ['user', 'user'],
    ['project', 'project'],
  ];
  return labels
    .filter(([k]) => counts[k] > 0)
    .map(([k, label]) => `${counts[k]} ${label}`)
    .join(' · ');
}

/**
 * Compute the change in registered skill names between the previous snapshot
 * and the current one. Returns null when there is no baseline (first
 * registration) so callers can omit the delta entirely.
 */
export function computeSkillDelta(
  prev: ReadonlySet<string>,
  next: ReadonlySet<string>,
): { added: string[]; removed: string[] } | null {
  if (prev.size === 0) return null;
  return {
    added: [...next].filter((n) => !prev.has(n)).sort(),
    removed: [...prev].filter((n) => !next.has(n)).sort(),
  };
}

/** Render a skill delta as a compact suffix, or '' when nothing changed. */
export function formatSkillDelta(delta: { added: string[]; removed: string[] }): string {
  const { added, removed } = delta;
  if (added.length === 0 && removed.length === 0) return '';
  const counts: string[] = [];
  if (added.length) counts.push(`+${added.length}`);
  if (removed.length) counts.push(`−${removed.length}`);
  let suffix = `${counts.join(' ')} since last reload`;
  // Name the skills when each side's change is small enough to stay scannable.
  const named: string[] = [];
  if (added.length > 0 && added.length <= 3) named.push(`new: ${added.map((n) => `/${n}`).join(', ')}`);
  if (removed.length > 0 && removed.length <= 3) {
    named.push(`gone: ${removed.map((n) => `/${n}`).join(', ')}`);
  }
  if (named.length > 0) suffix += ` (${named.join('; ')})`;
  return suffix;
}

/**
 * Render installed-plugin rows as dim, name-aligned lines (one per plugin):
 * `    example-plugin   v1.9.0`. Caps at 8 rows; extra plugins collapse into a
 * trailing `…and N more`. Returns [] when none are installed.
 */
export function buildPluginRows(plugins: InstalledPlugin[]): string[] {
  if (plugins.length === 0) return [];
  const MAX = 8;
  const shown = plugins.slice(0, MAX);
  const width = Math.min(24, shown.reduce((m, p) => Math.max(m, p.name.length), 0));
  const rows = shown.map((p) =>
    palette.dim(`    ${p.name.padEnd(width)}  ${formatPluginVersion(p)}`),
  );
  if (plugins.length > MAX) {
    rows.push(palette.dim(`    …and ${plugins.length - MAX} more`));
  }
  return rows;
}

/**
 * `/reload-plugins` — ask the session query to re-scan plugin dirs, then re-register
 * the passthrough commands. Useful after editing SKILL.md files on disk.
 */
export const reloadPluginsCmd: SlashCommand = {
  name: '/reload-plugins',
  summary: 'Reload plugin skills from disk and refresh the slash registry',
  async handler(ctx: SlashContext) {
    ctx.out.line();
    ctx.out.info('Reloading plugins…');
    // Snapshot the pre-reload skill set so we can report what changed on disk
    // (the common reason to reload is editing a SKILL.md). Captured before the
    // re-registration that reassigns `state.discovered`.
    const prevSkillNames = new Set(state.discovered.map((d) => d.name));
    // Invalidate the in-process scan cache so the next manifest build
    // (triggered by registerPluginSkills → session.supportedCommands)
    // reads fresh data from `~/.afk/plugins/` instead of stale results
    // memoized at session start. Without this, /reload-plugins would only
    // refresh the SDK's view; AFK's own scan would still serve the
    // pre-edit manifest.
    _resetPluginScanCache();
    try {
      // AgentSession re-exports the session query handle via
      // getQuery(); reloadPlugins() lives on that surface (the narrower
      // ProviderQuery shape omits it). Cleaner than reaching into private
      // internals and survives any future tightening of the provider boundary.
      const q = ctx.session.current.getQuery() as unknown as {
        reloadPlugins?: () => Promise<unknown>;
      };
      if (typeof q.reloadPlugins === 'function') {
        await q.reloadPlugins();
      }
    } catch (err) {
      ctx.out.warn(`Plugin reload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Refresh skills + agents in parallel — neither depends on the other.
    const [skillCount, agentCount] = await Promise.all([
      registerPluginSkills(ctx.session.current),
      registerPluginAgents(ctx.session.current),
    ]);
    if (skillCount === null && agentCount === null) {
      ctx.out.error('Could not refresh plugin skills or agents.');
      ctx.out.line();
      return 'continue';
    }

    const installed = listInstalledPlugins();

    // Headline: the counts, plus how many plugin dirs are actually loaded.
    const parts: string[] = [];
    if (skillCount !== null) parts.push(`${skillCount} skill${skillCount === 1 ? '' : 's'}`);
    if (agentCount !== null) parts.push(`${agentCount} agent${agentCount === 1 ? '' : 's'}`);
    const fromPlugins =
      installed.length > 0
        ? ` from ${installed.length} plugin${installed.length === 1 ? '' : 's'}`
        : '';
    ctx.out.success(`Reloaded ${parts.join(' + ')}${fromPlugins}.`);

    // Dim breakdown + delta — explains what the bare skill count is made of
    // (the registry spans built-in + plugin + user skills, so the total moves
    // little on reload) and what changed since the last registration.
    if (skillCount !== null) {
      const breakdown = buildSourceBreakdown(collectSkillEntries());
      const delta = computeSkillDelta(
        prevSkillNames,
        new Set(state.discovered.map((d) => d.name)),
      );
      const deltaStr = delta ? formatSkillDelta(delta) : '';
      const segs = [breakdown, deltaStr].filter((s) => s.length > 0);
      if (segs.length > 0) ctx.out.line(palette.dim(`  ${segs.join(' · ')}`));
    }

    // Dim per-plugin version rows — the answer to "which versions are loaded?".
    for (const row of buildPluginRows(installed)) ctx.out.line(row);

    ctx.out.line();
    return 'continue';
  },
};

/** Register the always-available commands (placeholder `/skills` + reload). */
export function registerStaticPluginSkillCommands(): void {
  register(initialSkillsCmd);
  register(reloadPluginsCmd);
}
