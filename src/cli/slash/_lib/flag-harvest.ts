/**
 * Shared SKILL.md frontmatter + body harvesting.
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

/** Scan a SKILL.md body for `--flag-name` patterns. Deduplicated and sorted. */
export function extractFlagsFromBody(body: string): string[] {
  const flags = new Set<string>();
  for (const match of body.matchAll(FLAG_REGEX)) {
    if (match[1]) flags.add(`--${match[1]}`);
  }
  return Array.from(flags).sort();
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

      if (after.startsWith('[')) {
        const m = after.match(/\[(.*?)\]/);
        if (m?.[1]) {
          const items = m[1]
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          if (items.length > 0) {
            frontmatterFlags = items.map(normalizeFlag).sort();
          }
        }
        continue;
      }

      if (after === '' || after === 'null') {
        const arr: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j];
          if (!next || !next.match(/^\s+-\s/)) break;
          const im = next.match(/^\s+-\s+(.+)/);
          if (im?.[1]) arr.push(im[1].trim());
        }
        if (arr.length > 0) {
          frontmatterFlags = arr.map(normalizeFlag).sort();
        }
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
  if (parsed.frontmatterFlags && parsed.frontmatterFlags.length > 0) {
    return parsed.frontmatterFlags;
  }
  const argHint = parsed.frontmatter?.['argument-hint'] ?? '';
  return extractFlagsFromBody(`${argHint}\n${parsed.body}`);
}
