/**
 * Slash-command registry and dispatcher.
 *
 * Commands register themselves on module import side-effect or via explicit
 * `register()` calls. The REPL calls `dispatch(input, ctx)` whenever input
 * starts with `/`. Unknown commands return a "did you mean?" hint by
 * Levenshtein-closest match.
 */

import type { SlashCommand, SlashContext, SlashResult } from './types.js';
import type { ImageAttachment } from '../input/attachments.js';

const commands: Map<string, SlashCommand> = new Map();
const aliases: Map<string, string> = new Map();

// Monotonic mutation counter. Bumped on every structural change to the
// registry (register / registerOrReplace / registerIfAbsent-that-adds /
// resetRegistry). Consumers that MEMOIZE work keyed on registry membership
// (e.g. `colorizeInputBuffer`, which colors a token by whether it is a known
// command) read `registryVersion()` so their cache invalidates the instant a
// plugin/skill command is hot-swapped in — a stale-colored buffer is worse
// than no memo. Not a semantic version; purely an opaque change token.
let version = 0;

/** Opaque monotonic token that changes whenever the registry membership changes. */
export function registryVersion(): number {
  return version;
}

/** Register a command. Throws on name collision to catch duplicates early. */
export function register(cmd: SlashCommand): void {
  if (commands.has(cmd.name)) {
    throw new Error(`Slash command already registered: ${cmd.name}`);
  }
  commands.set(cmd.name, cmd);
  for (const alias of cmd.aliases ?? []) {
    if (aliases.has(alias) || commands.has(alias)) {
      throw new Error(`Slash alias collides: ${alias}`);
    }
    aliases.set(alias, cmd.name);
  }
  version++;
}

/**
 * Register a command, replacing any existing command of the same name. Used
 * by the plugin-skill bridge which registers a placeholder at startup and
 * then hot-swaps in the real handlers once the SDK session initializes.
 * Aliases tied to the replaced command are dropped — callers should re-declare
 * aliases in the replacement cmd if they need them.
 */
export function registerOrReplace(cmd: SlashCommand): void {
  if (commands.has(cmd.name)) {
    for (const [alias, canonical] of aliases.entries()) {
      if (canonical === cmd.name) aliases.delete(alias);
    }
    commands.delete(cmd.name);
  }
  register(cmd);
}

/**
 * Register a command only if its name is not already in the registry.
 * Silently no-ops when the name is taken (e.g. by a user/plugin skill of the
 * same name). Use for built-in convenience commands that should yield to
 * user overrides without crashing on collision (COMPAT-2).
 */
export function registerIfAbsent(cmd: SlashCommand): void {
  if (!commands.has(cmd.name)) {
    register(cmd);
  }
}

/** Whether a name is registered (canonical or alias). */
export function has(nameOrAlias: string): boolean {
  return commands.has(nameOrAlias) || aliases.has(nameOrAlias);
}

/** Clear the registry — exposed for tests. */
export function resetRegistry(): void {
  commands.clear();
  aliases.clear();
  version++;
}

/** List all commands in deterministic name order. */
export function list(): SlashCommand[] {
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * List all registered aliases as `{ alias, canonical, summary }` triples.
 * Used by the autocomplete dropdown so that aliased commands (e.g. `/quit`
 * → `/exit`) appear as candidates alongside their canonical names. The
 * summary is borrowed from the canonical command.
 */
export function aliasEntries(): { alias: string; canonical: string; summary: string }[] {
  const out: { alias: string; canonical: string; summary: string }[] = [];
  for (const [alias, canonical] of aliases.entries()) {
    const cmd = commands.get(canonical);
    if (cmd) out.push({ alias, canonical, summary: cmd.summary });
  }
  return out.sort((a, b) => a.alias.localeCompare(b.alias));
}

/** Resolve a name-or-alias to its SlashCommand. */
export function lookup(nameOrAlias: string): SlashCommand | undefined {
  if (commands.has(nameOrAlias)) return commands.get(nameOrAlias);
  const canonical = aliases.get(nameOrAlias);
  return canonical ? commands.get(canonical) : undefined;
}

/** Compute Levenshtein distance — used only for suggestions. */
function editDistance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i++) dp[i]![0] = i;
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }
  return dp[a.length]![b.length]!;
}

/** Return the closest registered name within `maxDistance`, or undefined. */
export function suggest(input: string, maxDistance = 3): string | undefined {
  let best: { name: string; dist: number } | undefined;
  for (const name of commands.keys()) {
    const d = editDistance(input, name);
    if (d <= maxDistance && (best === undefined || d < best.dist)) {
      best = { name, dist: d };
    }
  }
  return best?.name;
}

/** Parse a raw input line into command name + args (or null if not a slash). */
export function parse(input: string): { name: string; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) return { name: trimmed, args: '' };
  return { name: trimmed.slice(0, spaceIdx), args: trimmed.slice(spaceIdx + 1).trim() };
}

/**
 * Dispatch a raw input line. If it's not a slash command, returns
 * `{ handled: false }` so the REPL can send the input to the agent.
 * Unknown slash commands print a did-you-mean hint and return
 * `{ handled: true, result: 'continue' }`.
 *
 * When `attachments` are provided and the resolved command does not declare
 * `acceptsAttachments: true`, a named warning is emitted and the images are
 * not forwarded (they would be silently ignored by a command that cannot
 * handle them). Commands with `acceptsAttachments: true` (skill commands)
 * receive the full attachment array as the third handler argument.
 */
export async function dispatch(
  input: string,
  ctx: SlashContext,
  attachments?: readonly ImageAttachment[],
): Promise<{ handled: boolean; result?: SlashResult }> {
  const parsed = parse(input);
  if (parsed === null) return { handled: false };

  const cmd = lookup(parsed.name);
  if (!cmd) {
    const hint = suggest(parsed.name);
    if (hint) {
      ctx.out.warn(`Unknown command: ${parsed.name}  (did you mean ${hint}?)`);
    } else {
      ctx.out.warn(`Unknown command: ${parsed.name}  (type /help for commands)`);
    }
    return { handled: true, result: 'continue' };
  }

  const atts = attachments ?? [];
  if (atts.length > 0 && cmd.acceptsAttachments !== true) {
    ctx.out.warn(
      `⚠ Image attachments are ignored by ${parsed.name} ` +
      `(images only reach the model on skill commands like /forge, /mint).`,
    );
  }

  const result = await cmd.handler(ctx, parsed.args, cmd.acceptsAttachments === true ? atts : undefined);
  // `forward` is the escape hatch for plugin-skill passthrough: the REPL
  // should pipe the original input straight to the SDK turn loop.
  if (result === 'forward') return { handled: false };
  return { handled: true, result };
}
