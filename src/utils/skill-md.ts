/**
 * Shared SKILL.md frontmatter + body harvesting.
 *
 * Layer-neutral home (#3332): the agent layer (`agent/plugins/tool-injector.ts`
 * parses plugin SKILL.md flags during discovery), the skills layer
 * (`skills/user-skills.ts`), and the CLI (`cli/slash/_lib/flag-harvest.ts`
 * re-exports this module) all share one parser. It must not import CLI code.
 *
 * Both the user-space scanner (~/.afk/skills/) and the plugin-skill bridge
 * (~/.afk/plugins/.../SKILL.md) need to extract the same kinds of metadata —
 * scalar frontmatter fields (name, description, argument-hint), an optional
 * `flags:` list, and CLI flags mentioned in the body. Centralising the parser
 * here keeps the two surfaces in lockstep and lets the unified `/skills`
 * renderer rely on a single shape.
 *
 * The frontmatter parser is intentionally minimal — only enough YAML to handle
 * scalar `key: value` lines, inline-form `flags: [--x, --y]`, and block-form
 * `flags:\n  - --x`. Skill authors that need richer YAML can wire up a real
 * parser later; this stays dependency-free.
 */

const FLAG_REGEX = /(?<![a-zA-Z0-9_/-])--([a-z][a-z0-9-]*)(?![a-zA-Z0-9_-])/g;

/** Ensure a flag string has the leading `--`. */
export function normalizeFlag(flag: string): string {
  return flag.startsWith('--') ? flag : `--${flag}`;
}

/** Maximum number of flags collected from the body scan (cap prevents unbounded sets). */
const BODY_FLAG_CAP = 64;

/** Scan a SKILL.md body for `--flag-name` patterns. Deduplicated, sorted, and capped at 64. */
export function extractFlagsFromBody(body: string): string[] {
  const flags = new Set<string>();
  for (const match of body.matchAll(FLAG_REGEX)) {
    if (match[1]) {
      flags.add(`--${match[1]}`);
      if (flags.size >= BODY_FLAG_CAP) break;
    }
  }
  return Array.from(flags).sort();
}

/** Anchored regex for whole-string flag validation — `--word` with no extra characters. */
const VALID_FLAG_EXACT = /^--[a-z][a-z0-9-]*$/;

/** Validate that a normalised flag string is exactly `--<word>` with no extra payload. */
function isValidFlag(flag: string): boolean {
  return VALID_FLAG_EXACT.test(flag);
}

/**
 * Deduplicate an array of normalised flag strings (first-seen order) and sort
 * the result. Shared by both the inline and block branches of `parseFlagsField`.
 */
function dedupeAndSort(flags: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const f of flags) {
    if (!seen.has(f)) {
      seen.add(f);
      unique.push(f);
    }
  }
  return unique.sort();
}

/**
 * Parse a frontmatter `flags:` value. `after` is the text following `flags:`
 * on the same line; `followingLines` are the frontmatter lines after it.
 *
 * Accepts the inline form (`flags: [--x, y]`) and the block form
 * (`flags:` / `null` followed by `  - --x` items). Items are normalised to a
 * leading `--`, validated against FLAG_REGEX (dropping any item that does not
 * match — e.g. `--foo; rm -rf /`), deduped, and sorted. Returns `null` when
 * no valid flags were declared.
 */
export function parseFlagsField(after: string, followingLines: readonly string[]): string[] | null {
  const value = after.trim();
  if (value.startsWith('[')) {
    const m = value.match(/\[(.*?)\]/);
    if (!m?.[1]) return null;
    const items = m[1]
      .split(',')
      .map((s) => normalizeFlag(s.trim()))
      .filter((s) => s.length > 2 && isValidFlag(s));
    const deduped = dedupeAndSort(items);
    return deduped.length > 0 ? deduped : null;
  }
  if (value !== '' && value !== 'null') return null;
  const arr: string[] = [];
  for (const next of followingLines) {
    if (!next || !next.match(/^\s+-\s/)) break;
    const im = next.match(/^\s+-\s+(.+)/);
    if (im?.[1]) {
      const flag = normalizeFlag(im[1].trim());
      if (isValidFlag(flag)) arr.push(flag);
    }
  }
  const deduped = dedupeAndSort(arr);
  return deduped.length > 0 ? deduped : null;
}

/**
 * Apply the flag precedence rules shared by every SKILL.md surface:
 * an explicit frontmatter `flags:` list wins outright; otherwise the union of
 * flags scanned from `argument-hint` and the body. Empty array if none.
 *
 * Contract — `frontmatterFlags` vs the return value:
 *   - `null`  → no `flags:` field was present in the frontmatter at all.
 *              Fall through to the body/hint scan.
 *   - `[]`    → `flags:` was present but listed nothing valid after
 *              normalisation / validation. Treat as absent (same fallthrough).
 *   - non-empty array → explicit author-declared flags; returned as-is.
 * The return value is ALWAYS `string[]` (never `null`): callers can safely
 * check `.length` or spread without a null guard.
 */
export function resolveSkillFlags(
  frontmatterFlags: readonly string[] | null | undefined,
  argumentHint: string | undefined,
  body: string,
): string[] {
  if (frontmatterFlags && frontmatterFlags.length > 0) return [...frontmatterFlags];
  return extractFlagsFromBody(`${argumentHint ?? ''}\n${body}`);
}

export interface ParsedSkillMd {
  /** Parsed frontmatter scalars. Only present when the file starts with `---`. */
  frontmatter: Record<string, string> | null;
  /** Frontmatter `flags:` value (inline or block form), normalised + sorted. */
  frontmatterFlags: string[] | null;
  /** Everything after the closing `---`. Equal to the full content if no frontmatter. */
  body: string;
}

/**
 * Split a SKILL.md document into frontmatter + body, parsing the most common
 * fields. Returns `frontmatter: null` for documents without a frontmatter block.
 */
export function parseSkillMd(content: string): ParsedSkillMd {
  if (!content.startsWith('---\n')) {
    return { frontmatter: null, frontmatterFlags: null, body: content };
  }
  const endIdx = content.indexOf('\n---\n', 4);
  if (endIdx === -1) {
    return { frontmatter: null, frontmatterFlags: null, body: content };
  }

  const yamlText = content.slice(4, endIdx);
  const body = content.slice(endIdx + 5);

  const frontmatter: Record<string, string> = {};
  let frontmatterFlags: string[] | null = null;

  const lines = yamlText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim() || line.trimStart().startsWith('#')) continue;

    if (line.startsWith('flags:')) {
      const after = line.slice('flags:'.length).trim();
      if (after.startsWith('[') || after === '' || after === 'null') {
        const parsedFlags = parseFlagsField(after, lines.slice(i + 1));
        if (parsedFlags) frontmatterFlags = parsedFlags;
        continue;
      }
    }

    const m = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (m && m[1] !== undefined && m[2] !== undefined) {
      const value = m[2].trim().replace(/^['"]|['"]$/g, '');
      if (value.length > 0) frontmatter[m[1]] = value;
    }
  }

  return { frontmatter, frontmatterFlags, body };
}

/**
 * One-shot helper: harvest flags from a SKILL.md document.
 *
 * Precedence (highest first):
 *   1. An explicit frontmatter `flags:` list — the unambiguous, author-declared
 *      set. Wins outright when present.
 *   2. Otherwise, the union of flags scanned from the `argument-hint` frontmatter
 *      field AND the body. `argument-hint` is a standard Claude Code /
 *      agentskills.io-compatible field that declares the CLI surface, so flags
 *      written there (e.g. `[--post github|telegram]`) complete in the REPL
 *      dropdown without a proprietary `flags:` field. The body is still scanned
 *      as a legacy fallback for skills that mention flags only in prose.
 *
 * Empty array if none produced anything.
 */
export function harvestFlagsFromSkillMd(content: string): string[] {
  const parsed = parseSkillMd(content);
  return resolveSkillFlags(parsed.frontmatterFlags, parsed.frontmatter?.['argument-hint'], parsed.body);
}
