---
name: ground-claim
description: "Use when the user asks a meta-capability question about a system/framework/repo ('what does X enable', 'what can this do', 'list the capabilities'). Forces file-read grounding with path:line citations before answering; tags any unverifiable claim as [UNVERIFIED]."
argument-hint: "<the meta-capability question>"
---

## Trigger

Self-referential meta-capability questions about the current repository, framework, or system. Examples:

- "What does this repo enable?"
- "What are the orchestration patterns available?"
- "List the available skills."
- "What capabilities does the plugin provide?"
- "Show me what the framework can do."

Skip: usage questions ("how do I use X?"), bug reports, feature requests, technical implementation questions.

## Procedure

1. **Extract capability nouns.** From the user's question, identify 2–5 concrete capability categories (e.g., skills, hooks, agents, orchestration patterns, CLI commands, verification methods). Write them down.

2. **Locate and read evidence.** For each capability noun:
   - Use Glob or Grep to locate source files (e.g., `skills/*/SKILL.md` for skills, `hooks/` for hooks, `agents/` for agents).
   - Read at least one concrete source file per capability. Record the file path and specific line numbers.
   - Do not rely on training data, model recall, or session-listing attachments. Evidence must come from Read tool output.

3. **Build the answer inline.** As you write the response, embed citations **within claims**, not in a separate appendix. Format: `path/to/file.md:line—<claim context>`. Example: `skills/mint/SKILL.md:5—the mint skill orchestrates end-to-end feature delivery`.

4. **Tag ungrounded claims.** If a capability claim cannot be traced to a file read, prefix it with `[UNVERIFIED: what would be needed to verify this]`. Never present an unverified claim without the tag.

5. **Declare sources read.** Explicitly name which files you read in the response (e.g., "Read: `skills/mint/SKILL.md`, `hooks/hooks.json`").

## Hard rules

- Do not answer from model recall alone.
- Do not answer from session-listing attachments without reading the underlying SKILL.md or manifest files.
- Do not summarize without citation. Every capability claim must point to a source.
- Do not bury unverified claims. Use the `[UNVERIFIED]` prefix and state the evidence gap.
- At least one `path:line` citation per named capability.

## Exit criteria

- Response contains ≥1 `path:line` citation per capability mentioned.
- Every unverified claim is explicitly tagged with `[UNVERIFIED: …]`.
- Response explicitly lists which files were read (not just quoted).
- No claims rest on model recall or default knowledge.

## Out of scope

- Usage questions ("how do I use library X?") → normal research.
- Bug reports → `/diagnose`.
- Building new capability → `/mint`.
- Verification of sub-agent findings → `/shadow-verify`.
