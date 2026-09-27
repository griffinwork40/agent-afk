/**
 * Hook matcher compilation.
 *
 * Compiles a raw matcher string (from a hook group's `matcher` field) into a
 * predicate that tests an AFK tool name. Designed to be compatible with both
 * AFK-native hook configs and Claude Code plugin hooks.json files.
 *
 * Semantics, in priority order:
 *   1. `undefined`, `""`, or `"*"` — always true (match any tool).
 *   2. `"/pattern/[flags]"` — compiled as RegExp; g/y flags stripped (stateful).
 *      Invalid regex falls back to exact equality with a warning.
 *   3. Bare string containing only word characters and `|` — treated as a
 *      pipe-separated list of exact names; matched against the AFK tool name
 *      AND all of its Claude Code aliases.
 *   4. Any other bare string — compiled as anchored regex `^(?:...)$` so
 *      patterns like `"Web.*"` work naturally; invalid regex falls back to
 *      exact equality with a warning.
 *
 * Alias resolution: every AFK tool name maps to zero or more Claude Code names
 * (e.g. `edit_file` → `["Edit", "MultiEdit"]`). When testing a Claude Code
 * bare-name list or anchored-regex bare string, the match is run against the
 * AFK name AND each of its Claude Code aliases. Matching is case-sensitive,
 * consistent with Claude Code.
 *
 * Backward compatibility: existing AFK matchers are unaffected.
 *   - `"bash"` matches only `bash` (exact pipe-list of one name, alias "Bash"
 *     means `"Bash"` also matches `bash`).
 *   - `"/^agent$/"` still matches only `agent` via the regex path (path 2).
 *   - `"*"` still matches everything.
 *
 * @module agent/hooks/matcher
 */

// ---------------------------------------------------------------------------
// Claude Code alias table
//
// Maps each AFK canonical tool name to the set of Claude Code names that
// refer to it. Used bidirectionally: a Claude Code matcher string that names
// "Edit" should fire when AFK invokes "edit_file", and vice versa.
//
// Sources verified against:
//   src/agent/tools/schemas*.ts (AFK canonical names)
//   src/agent/plugins/tool-injector.ts (LEGACY_TOOL_ALIASES — skill frontmatter)
//   src/agent/tool-category.ts (Claude Code category names)
//   claude-jev hooks.json (real-world Claude Code hook matchers)
// ---------------------------------------------------------------------------

/** Maps AFK canonical tool name → array of Claude Code alias names. */
export const CLAUDE_CODE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  bash: ['Bash'],
  read_file: ['Read'],
  write_file: ['Write'],
  edit_file: ['Edit', 'MultiEdit'],
  patch_apply: ['MultiEdit'],
  view_image: ['Read'],
  extract_document: ['Read'],
  glob: ['Glob'],
  grep: ['Grep'],
  list_directory: ['LS'],
  agent: ['Agent', 'Task'],
  web_scrape: ['WebFetch', 'WebSearch'],
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a reverse index: Claude Code alias → AFK canonical name.
 * Used only for documentation/cross-reference; actual matching tests the AFK
 * name against all aliases rather than going through the reverse map.
 */
function buildReverseAliasIndex(): ReadonlyMap<string, string> {
  const m = new Map<string, string>();
  for (const [afkName, aliases] of Object.entries(CLAUDE_CODE_ALIASES)) {
    for (const alias of aliases) {
      m.set(alias, afkName);
    }
  }
  return m;
}

/** Reverse map: Claude Code alias → AFK canonical name. */
const REVERSE_ALIAS_INDEX = buildReverseAliasIndex();
void REVERSE_ALIAS_INDEX; // referenced by tests via CLAUDE_CODE_ALIASES; kept for completeness

/**
 * Return all names to test for a given AFK tool name: the name itself plus
 * all of its Claude Code aliases. Order: AFK name first.
 */
function allNamesForTool(afkToolName: string): readonly string[] {
  const aliases = CLAUDE_CODE_ALIASES[afkToolName];
  return aliases !== undefined ? [afkToolName, ...aliases] : [afkToolName];
}

/**
 * Pattern for a bare pipe-list of exact names: contains only word chars and
 * pipes. `\w` = [A-Za-z0-9_]. This covers both AFK names (`bash`, `edit_file`)
 * and Claude Code names (`Bash`, `Edit`, `Agent|Task`).
 */
const PIPE_LIST_RE = /^[\w|]+$/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compile a matcher string into a predicate that tests an AFK tool name.
 *
 * The predicate receives the AFK canonical tool name (e.g. `"bash"`) and
 * returns `true` when the hook group should fire for that tool.
 *
 * @param matcher - Raw matcher string from hook config, or `undefined`.
 * @param warn    - Optional sink for non-fatal warnings (e.g. invalid regex).
 *                  Called at most once per `compileMatcher` invocation.
 */
export function compileMatcher(
  matcher: string | undefined,
  warn?: (msg: string) => void,
): (toolName: string) => boolean {
  // Path 1: match everything
  if (matcher === undefined || matcher === '' || matcher === '*') return () => true;

  // Path 2: explicit regex syntax  /pattern/[flags]
  const regexMatch = /^\/(.+)\/([gimsuy]*)$/.exec(matcher);
  if (regexMatch !== null) {
    const pattern = regexMatch[1]!;
    const rawFlags = regexMatch[2]!;
    // Strip g/y flags — both are stateful and would alternate true/false on a
    // reused (cached) RegExp instance across successive tool invocations.
    const safeFlags = rawFlags.replace(/[gy]/g, '');
    try {
      const re = new RegExp(pattern, safeFlags);
      return (toolName: string) => re.test(toolName);
    } catch {
      // Invalid regex in /…/ syntax: fall back to exact equality.
      warn?.(`hook matcher "${matcher}": invalid regex — falling back to exact equality`);
      return (toolName: string) => toolName === matcher;
    }
  }

  // Path 3: bare pipe-separated list of exact names (most Claude Code matchers)
  // e.g. "Bash", "Edit|Write|MultiEdit|NotebookEdit", "Agent|Task", "bash"
  if (PIPE_LIST_RE.test(matcher)) {
    const names = new Set(matcher.split('|'));
    return (toolName: string) => {
      // Check the AFK canonical name and all its Claude Code aliases.
      for (const candidate of allNamesForTool(toolName)) {
        if (names.has(candidate)) return true;
      }
      return false;
    };
  }

  // Path 4: bare string with special chars — treat as anchored regex ^(?:...)$
  // e.g. "Web.*" should match web_scrape via its aliases.
  try {
    const re = new RegExp(`^(?:${matcher})$`);
    return (toolName: string) => {
      for (const candidate of allNamesForTool(toolName)) {
        if (re.test(candidate)) return true;
      }
      return false;
    };
  } catch {
    // Invalid anchored regex: fall back to exact equality.
    warn?.(`hook matcher "${matcher}": invalid regex — falling back to exact equality`);
    return (toolName: string) => toolName === matcher;
  }
}
