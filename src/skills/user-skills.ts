/**
 * Disk-based skill scanner.
 *
 * Discovers SKILL.md files under a given directory, parses their YAML
 * frontmatter, and registers each as a skill.
 *
 * Execution mode follows the SKILL.md `context:` frontmatter field, with the
 * same default as plugin skills (skill-executor.ts): in-context **load**
 * unless the author explicitly opts into `context: fork`.
 *   - default / `context: load` → the SKILL.md body is returned as the tool
 *     result and the CURRENT agent carries it out with its existing tools
 *     (progressive disclosure; `${SKILL_ROOT}` expanded in-place). No fork.
 *   - `context: fork` → the handler dispatches a subagent with the SKILL.md
 *     body as the system prompt and the user's input as the first message
 *     (delegation; isolated child context).
 *
 * Two scopes use this scanner:
 *   - **User-scope** (`~/.afk/skills/`) — global user skills.
 *   - **Project-scope** (`<cwd>/.afk/skills/`) — per-project skills,
 *     auto-discovered from the working directory.
 *
 * On bare-name collision with an already-registered skill, the new skill
 * gets registered under the namespaced fallback `<origin>:<name>` (e.g.
 * `user:mint`, `project:lint`) — the earlier registrant wins the bare
 * name, but the later one stays reachable.
 *
 * Frontmatter parsing, flag harvesting, and body extraction are delegated
 * to `src/cli/slash/_lib/flag-harvest.ts` so the user surface stays in
 * lockstep with the plugin surface.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { getSkillsDir } from '../paths.js';
import {
  getSkill,
  registerSkill,
  type SkillExecutionContext,
  type SkillMetadata,
} from './index.js';
import { harvestFlagsFromSkillMd, parseSkillMd } from '../cli/slash/_lib/flag-harvest.js';
import { SubagentManager } from '../agent/subagent.js';
import type { IAgentSession } from '../agent/types.js';

interface ParsedSkillMd {
  name: string;
  description: string;
  argumentHint?: string;
  flags?: readonly string[];
  body: string;
  /** Absolute path of the skill's root directory (e.g. `~/.afk/skills/<name>/`). */
  dir: string;
  /**
   * Execution mode from the `context:` frontmatter field. Only the three
   * well-known values are accepted; anything else (typo, omitted) is left
   * `undefined` and treated as the default (load) by the registrant.
   */
  context?: 'inline' | 'fork' | 'load';
}

/**
 * Validate a skill name against the agentskills.io v1 spec.
 *
 * Spec requirements:
 *   - 1–64 characters
 *   - Only lowercase a-z, 0-9, and hyphens
 *   - No leading or trailing hyphen
 *   - No consecutive hyphens
 *   - Must equal the parent directory name (checked separately by the caller)
 *
 * @returns `{ valid: true }` on success, or `{ valid: false, reason: string }` on failure.
 */
export function validateSkillName(
  name: string,
  dirname: string,
): { valid: true } | { valid: false; reason: string } {
  if (name.length === 0 || name.length > 64) {
    return { valid: false, reason: `name must be 1–64 characters, got ${name.length}` };
  }
  // Spec regex: lowercase a-z0-9 segments joined by single hyphens.
  // Equivalent: ^[a-z0-9]+(-[a-z0-9]+)*$
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    return {
      valid: false,
      reason: `name "${name}" does not match spec pattern ^[a-z0-9]+(-[a-z0-9]+)*$ ` +
        `(only lowercase a-z0-9 and hyphens, no leading/trailing/consecutive hyphens)`,
    };
  }
  if (name !== dirname) {
    return {
      valid: false,
      reason: `name field "${name}" does not match parent directory name "${dirname}"`,
    };
  }
  return { valid: true };
}

/** Maximum description length per agentskills.io v1 spec. */
const MAX_DESCRIPTION_LENGTH = 1024;

function parseUserSkillMd(content: string, dirname: string): ParsedSkillMd | null {
  const parsed = parseSkillMd(content);
  if (!parsed.frontmatter) return null;

  const name = parsed.frontmatter['name'];
  const description = parsed.frontmatter['description'];
  const body = parsed.body.trim();
  if (!name || !description || body.length === 0) return null;

  // Validate name against agentskills.io v1 spec before accepting the skill.
  const nameValidation = validateSkillName(name, dirname);
  if (!nameValidation.valid) {
    process.stderr.write(`[afk] skipping skill ${dirname}: ${nameValidation.reason}\n`);
    return null;
  }

  // Validate description length per spec (max 1024 chars).
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    process.stderr.write(
      `[afk] skipping skill ${dirname}: description exceeds ${MAX_DESCRIPTION_LENGTH} characters ` +
        `(got ${description.length})\n`,
    );
    return null;
  }

  const argumentHint = parsed.frontmatter['argument-hint'] ?? parsed.frontmatter['argumentHint'];
  const flags = harvestFlagsFromSkillMd(content);

  const out: ParsedSkillMd = { name, description, body, dir: '' };
  if (argumentHint && argumentHint.length > 0) out.argumentHint = argumentHint;
  if (flags.length > 0) out.flags = flags;
  // Only accept the three well-known modes; an unknown value (typo) falls
  // through to the default (load) rather than silently mis-routing.
  const rawContext = parsed.frontmatter['context'];
  if (rawContext === 'inline' || rawContext === 'fork' || rawContext === 'load') {
    out.context = rawContext;
  }
  return out;
}

function makeUserSkillHandler(parsed: ParsedSkillMd): SkillMetadata['handler'] {
  return async (
    input: unknown,
    parentSession?: IAgentSession,
    ctx?: SkillExecutionContext,
  ) => {
    const subagentModel = ctx?.defaultSubagentModel ?? ctx?.defaultModel ?? 'sonnet';

    // Invariant: name the skill explicitly — a bare "Run the skill." is
    // ambiguous and lets the sub-agent ask the operator "which skill?" instead
    // of executing its own SKILL.md body. Mirrors skill-executor.ts.
    const userMessage = typeof input === 'string' && input.length > 0
      ? input
      : `Run the ${parsed.name} skill now, following the instructions in your system prompt.`;

    const manager = new SubagentManager({
      parentAbortSignal: parentSession?.abortSignal,
      // Forward the parent's witness writer (when ctx supplies one) so this
      // user-skill's forked sub-agent inherits it and its tool activity —
      // including any permission-denials a restricted user SKILL.md produces —
      // lands in the parent trace. See skills/index.ts SkillExecutionContext.traceWriter.
      //
      // Read-scope note (#547): this manager passes no `cwd`, so its fork is
      // read-open — which already satisfies the child ⊇ parent read-scope
      // invariant (#544/#547) for any parent. Seeding parentReadRoots from a
      // CONFINED session would only NARROW the fork (an arbitrary user SKILL.md
      // may legitimately read outside the worktree, e.g. its own
      // `~/.afk/skills/<name>` dir), so it is intentionally omitted. Worktree
      // isolation for user skills (passing cwd) is a separate, pre-existing gap.
      ...(ctx?.traceWriter !== undefined ? { traceWriter: ctx.traceWriter } : {}),
    });

    // `parentId: ctx.callId` (when present) anchors the synthesized
    // `Agent(<label>)` entry under THIS skill's tool-lane entry both in the
    // live overlay and in the committed scrollback block. See
    // skills/index.ts SkillExecutionContext.callId — without it the
    // subagent unparents to root the moment its Done block commits.
    const skillCallId = ctx?.callId;
    // SKILL_ROOT is injected here so shell commands in the user SKILL.md
    // body — e.g. `python3 "${SKILL_ROOT}/scripts/foo.py"` — resolve to the
    // skill's actual install path. Mirrors the PLUGIN_ROOT injection in
    // src/agent/tools/skill-executor.ts:599-612 for plugin skills.
    const handle = await manager.forkSubagent({
      parent: {
        sessionId: parentSession?.sessionId,
        getInputStreamRef: parentSession?.getInputStreamRef?.bind(parentSession),
        abortSignal: parentSession?.abortSignal,
      },
      config: {
        model: subagentModel,
        systemPrompt: parsed.body,
        env: { SKILL_ROOT: parsed.dir },
        // Invariant: like the plugin/registry dispatch paths in
        // skill-executor.ts, a user-authored skill is dispatched AS a specific
        // skill. isSkillDispatch strips the SLASH_COMMAND_ROUTING_PROMPT (which
        // is written for the main session and references <command-name> tags
        // this sub-agent never receives) and the ask_question escape hatch, so
        // the sub-agent engages its SKILL.md body instead of asking the
        // operator "which skill?".
        isSkillDispatch: true,
      },
      idPrefix: `user-skill-${parsed.name}`,
      agentType: `user-skill-${parsed.name}`,
      ...(skillCallId ? { parentId: skillCallId } : {}),
    });

    const result = await handle.runToResult(userMessage);
    return result;
  };
}

/**
 * Pick the registry key for a scanned skill: bare name when free,
 * `<origin>:<name>` when an already-registered skill of a *different* origin
 * occupies the bare slot. A same-origin re-scan is idempotent — Map.set
 * overwrites — so we reuse the bare name and avoid the duplicate-entry
 * problem that arises when collectSkillEntries() is called multiple times
 * (e.g. once per manifest/schema build after the CLI slash-command path
 * already ran a scan at startup).
 */
function resolveSkillKey(name: string, origin: SkillScanOrigin): string {
  try {
    const existing = getSkill(name);
    // Only escalate to a namespaced key when the bare slot is held by a
    // *different* origin. A same-origin re-scan is idempotent (Map.set
    // overwrites), so we can safely reuse the bare name.
    // Note: vendored builtins have `origin === undefined`, which is never
    // equal to 'user' or 'project', so the escalation still fires correctly
    // for builtin collisions.
    if (existing.origin === origin) return name;
    return `${origin}:${name}`;
  } catch {
    return name;
  }
}

/**
 * Scan a directory for SKILL.md files and register each as a skill.
 * Returns the count of skills discovered. Idempotent for same-origin
 * re-scans: resolveSkillKey() reuses the bare name when the existing
 * registry entry shares the same origin, so repeated calls do not
 * produce duplicate namespaced aliases (e.g. both `foo` and `user:foo`).
 */
/**
 * Origin tag for a disk skill scan. `'user'` / `'project'` are the native
 * scopes; `imported:<binary>` marks skills live-read from a trusted source
 * binary (Claude Code, Codex) opted into via `importFrom`. Native scopes are
 * scanned first so they win bare-name collisions; an imported skill of the
 * same name falls back to `imported:<binary>:<name>`.
 */
export type SkillScanOrigin = 'user' | 'project' | `imported:${string}`;

export function scanSkillsFromDir(
  dir: string,
  origin: SkillScanOrigin,
): number {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // A missing skills dir is the common case (most users have none), so stay
    // silent on ENOENT. Surface only unexpected failures (EACCES, broken
    // symlink) so a misconfigured dir doesn't vanish without a trace — mirrors
    // the `[afk] skipping skill …` signal in parseUserSkillMd.
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      process.stderr.write(`[afk] skipping skills dir ${dir}: ${e.message}\n`);
    }
    return 0;
  }

  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) {
      continue;
    }

    let content;
    try {
      content = readFileSync(join(dir, entry.name, 'SKILL.md'), 'utf-8');
    } catch (err) {
      // ENOENT just means the subdirectory carries no SKILL.md (not a skill),
      // so skip quietly. Surface permission/symlink failures so a present-but-
      // unreadable skill leaves a trace instead of silently disappearing.
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') {
        process.stderr.write(`[afk] skipping skill ${entry.name}: ${e.message}\n`);
      }
      continue;
    }

    const parsed = parseUserSkillMd(content, entry.name);
    if (!parsed) continue;
    // Populate the on-disk directory path now that we know the entry name.
    parsed.dir = join(dir, entry.name);

    const registryKey = resolveSkillKey(parsed.name, origin);
    const meta: SkillMetadata = {
      name: registryKey,
      description: parsed.description,
      handler: makeUserSkillHandler(parsed),
      origin,
    };
    if (parsed.argumentHint) meta.argumentHint = parsed.argumentHint;
    if (parsed.flags && parsed.flags.length > 0) meta.flags = parsed.flags;
    // Default to in-context LOAD; fork only when `context: fork` is explicit
    // (symmetric with the plugin-skill default in skill-executor.ts). In load
    // mode we set `context: 'load'` + `loadBody` so the executor's load path
    // returns the body to the current agent instead of invoking the (forking)
    // handler. In fork mode we leave `context` unset so the registry executor
    // falls through to the handler, which forks via makeUserSkillHandler — the
    // disk-skill body is NOT at the built-in prompts/system.md path the
    // executor's own fork branch expects, so we must keep using the handler.
    if (parsed.context !== 'fork') {
      meta.context = 'load';
      // SKILL_ROOT is expanded in-place here, not via subagent env, because
      // load mode runs in the CURRENT agent. Mirrors the PLUGIN_ROOT expansion
      // in skill-executor.ts's plugin load path.
      meta.loadBody = parsed.body.replace(/\$\{?SKILL_ROOT\}?/g, () => parsed.dir);
    }
    registerSkill(meta);
    count++;
  }

  return count;
}

/**
 * Scan `~/.afk/skills/` for SKILL.md files and register each as a skill.
 * Convenience wrapper around {@link scanSkillsFromDir}.
 */
export function scanAndRegisterUserSkills(): number {
  return scanSkillsFromDir(getSkillsDir(), 'user');
}
