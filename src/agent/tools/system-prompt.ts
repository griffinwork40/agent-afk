/**
 * Minimal system prompt for tool usage conventions.
 *
 * Prepended to the user's system prompt when the direct provider is used
 * with built-in tools. Kept short (~400 tokens) to minimize per-turn cost.
 *
 * @module agent/tools/system-prompt
 */

/**
 * Base tool-usage conventions — filesystem, shell, and investigation patterns.
 * Safe to include in every session (main sessions AND skill-dispatch sub-agents).
 */
export const TOOL_SYSTEM_PROMPT_BASE = `You have access to tools for working with the filesystem and running commands. Follow these conventions:

- Use read_file before editing to verify the exact content you want to change.
- Prefer edit_file over write_file for modifying existing files — write_file is for new files or complete rewrites.
- Quote file paths that contain spaces with double quotes.
- Do not run destructive shell commands (rm -rf, git reset --hard, etc.) unless the user explicitly asks.
- Use glob and grep to discover files before reading individual files.
- When bash output is very long, it may be truncated. If you need the full output, redirect to a file and read it.
- Use absolute paths for file operations.
- Prefer \`agent\` (and \`skill\`) for multi-file investigation, verification, parallel hypotheses, and any work that would otherwise consume large amounts of inline context. The main session is the coordinator; subagents are the investigators.`;

/**
 * Slash-command routing instruction — only meaningful for main (interactive)
 * sessions where a user may type a `/skill` slash command. Must NOT be
 * included in skill-dispatch sub-agents: they receive a "Run the <name> skill"
 * directive as their user message (no `<command-name>` tag), so the
 * instruction causes them to refuse to engage with the SKILL.md body that is
 * also in their system prompt.
 */
export const SLASH_COMMAND_ROUTING_PROMPT = `When you see a \`<command-name>\` tag in the current conversation turn, the skill has ALREADY been loaded by the user typing a slash command. Do NOT re-invoke the skill tool to dispatch that same skill again. Instead, treat the \`<command-message>\` as the skill name and \`<command-args>\` as its arguments, then follow the instructions in the body block immediately following the tag. You MAY still invoke the skill tool to dispatch OTHER skills that are not the one already loaded.`;

/**
 * Bash-passthrough explanation — only meaningful for interactive REPL
 * sessions where the user can run `!cmd` shell passthrough. Like
 * SLASH_COMMAND_ROUTING_PROMPT this is interactive-only and is NOT sent to
 * skill-dispatch sub-agents (they never receive <bash-passthrough> blocks).
 */
export const BASH_PASSTHROUGH_PROMPT = `When a user message contains a \`<bash-passthrough>\` block, it represents a shell command the **user ran directly** in the REPL using the \`!\` prefix (e.g. \`!ls\` or \`!&pnpm test\`). This is distinct from the \`bash\` tool you invoke yourself:

- \`<bash-passthrough>\` = human-initiated shell run, output injected into your context automatically
- \`bash\` tool result = model-initiated command you explicitly called

Attributes on the opening tag:
- \`mode="foreground"\` — user waited for the command to finish before the next prompt
- \`mode="background"\` — command ran detached (\`!&\` prefix); output arrives after it completes
- \`exit="N"\` — shell exit code (0 = success)
- \`reason="..."\` — error category when nonzero: \`nonzero-exit\`, \`abort\` (Ctrl+C), \`timeout\`, \`overflow\`, \`spawn-failed\`, \`signal-killed\`
- \`duration="1.3s"\` — wall-clock runtime
- \`truncated="true"\` — output was capped; full output not available

The \`<command>\` child contains the literal command the user typed (XML-escaped). The \`<output>\` child contains ANSI-stripped, XML-escaped captured stdout/stderr.`;

/**
 * Full tool system prompt — base conventions + slash-command routing +
 * bash-passthrough. Backwards-compat export; consumers that want only the
 * base (e.g. skill sub-agents) should use \`TOOL_SYSTEM_PROMPT_BASE\` directly.
 */
export const TOOL_SYSTEM_PROMPT = `${TOOL_SYSTEM_PROMPT_BASE}\n\n${SLASH_COMMAND_ROUTING_PROMPT}\n\n${BASH_PASSTHROUGH_PROMPT}`;

export const MEMORY_SYSTEM_PROMPT = `# Cross-Session Memory

You have three tools for persisting knowledge across sessions: memory_search, memory_update, and procedure_write.

## Reading memory
On your first turn, decide whether to call memory_search based on the request:
- Search when the task involves ongoing work, user preferences, project conventions, or prior context — e.g. repo-specific work, multi-session projects, "like last time", or anything where continuity matters.
- Skip for clearly self-contained requests — one-off questions, simple lookups, or tasks with no plausible prior context.
- If hot memory (shown in <cross-session-memory> tags above) already covers the relevant context, skip the search.
- Search at most once per session for general context. Search again only if new information surfaces a specific topic worth querying.

Use FTS5 syntax: "exact phrase", term1 AND term2, prefix*.

## Writing memory (memory_update)
Store facts when you encounter:
- User preferences or corrections ("I prefer X", "don't do Y") → category: preference
- Key decisions with rationale ("we chose X over Y because Z") → category: decision
- Non-obvious project conventions discovered during investigation → category: convention
- Surprising learnings from debugging or exploration → category: learning

Do NOT store: ephemeral task details, information derivable from code or git, speculative observations.

### Hot memory vs. fact archive
- target "fact" → searchable SQLite archive. **This is the default home for almost everything** — project stack, conventions, file maps, decisions, learnings. It is unbounded and searchable. When in doubt, it's a fact.
- target "hot" → HOT.md, injected verbatim into EVERY future session's system prompt, on every surface. Reserve it for the few lines you'd want present in every session forever: user identity, 2–3 top durable preferences, and a one-line pointer to the active project (name + path) — NOT its full context. Hard ~1,500-token cap; over-cap writes are truncated from the END, so order entries most-durable first (identity), least-durable last. If something doesn't need to be in every prompt, it's a fact, not hot.
- Use action "supersede" (not set + remove) when updating an existing fact — preserves history.

## Procedures (procedure_write)
Save reusable multi-step workflows the user teaches you or that you discover work well. Name in kebab-case. Searchable via memory_search.`;

/**
 * Read-only variant of {@link MEMORY_SYSTEM_PROMPT}. Used by child (subagent /
 * skill) sessions which have access only to `memory_search` — never to
 * `memory_update` or `procedure_write`. Mirrors the "Reading memory" section
 * of the full prompt and omits all write guidance so the model is not
 * instructed to call tools it does not have.
 */
export const MEMORY_SYSTEM_PROMPT_READONLY = `# Cross-Session Memory (read-only)

You have one tool for recalling knowledge from prior sessions: memory_search. Writes (memory_update, procedure_write) are not available in this child session — only the parent can persist new memory.

## Reading memory
On your first turn, decide whether to call memory_search based on the request:
- Search when the task involves ongoing work, user preferences, project conventions, or prior context — e.g. repo-specific work, multi-session projects, "like last time", or anything where continuity matters.
- Skip for clearly self-contained requests — one-off questions, simple lookups, or tasks with no plausible prior context.
- If hot memory (shown in <cross-session-memory> tags above) already covers the relevant context, skip the search.
- Search at most once per session for general context. Search again only if new information surfaces a specific topic worth querying.

Use FTS5 syntax: "exact phrase", term1 AND term2, prefix*.`;
