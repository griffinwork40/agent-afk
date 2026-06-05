# Skill execution modes: `inline` / `fork` / `load`

Status: implemented (v1). Scope-frozen 2026-06-01.

## Why this exists

agent-afk runs on the raw Messages API, not the Claude Code harness. The
primitive it built first was `SubagentManager.forkSubagent`, so the `skill`
tool became a **delegation** primitive: every skill ultimately forked an
isolated child `AgentSession` (or, for the five inline TS skills, ran a handler
that itself forks). That is the *opposite* polarity from Claude Code's Skill,
which **loads** a capability into the *current* context (progressive
disclosure).

`load` mode restores the two-primitive split:

| Mode | Mechanic | Context | Analogue |
|------|----------|---------|----------|
| `inline` (default) | run the TS `handler` in-process | current process | orchestrator skills (mint, forge, diagnose, audit-fit, score) |
| `fork` | fork a subagent with `prompts/system.md` as its system prompt | **isolated** child | Claude Code `Agent`/`Task` (delegation) |
| `load` | return `prompts/system.md` / SKILL.md body as the tool result; the **current** agent executes it with its existing tools | **current** session | Claude Code inline Skill (progressive disclosure) |

## How `load` works

1. The model invokes the `skill` tool by name (or a slash command routes to it).
2. `SkillExecutor` resolves the body:
   - registry skill → `loadSkillPrompts(name)['system.md']`
   - plugin skill → the SKILL.md body (when frontmatter declares `context: load`)
3. `$ARGUMENT` / `$ARGUMENTS` placeholders are substituted from the caller's args.
4. The body is wrapped in an **execute-now framing header** and returned as the
   tool result. No subagent is forked; no new session is created.
5. The current agent reads the tool result and carries out the instructions
   in-context with the tools it already has.

The framing header is load-bearing: without it the model may *summarize* the
body instead of *executing* it (risk R1). It states explicitly that the body is
an instruction set to act on now, not reference material.

## Authoring a `load` skill

Registry (built-in / `~/.afk/skills/`):

```ts
registerSkill({
  name: 'my-skill',
  description: '…',
  context: 'load',
  handler: async () => '', // unused in load mode; kept for type compat / tests
});
// requires src/skills/my-skill/prompts/system.md
```

Plugin (`SKILL.md` frontmatter):

```markdown
---
name: my-skill
description: …
context: load
---
Your in-context operating procedure. May reference $ARGUMENTS.
```

When `context` is omitted, plugin skills keep their historical behavior (fork).

## When to use which mode

- `load` — cheap, in-context capabilities that should run *as* the current
  agent (small leaf procedures, checklists, single-pass transforms). No fork
  latency, no separate context window. Cost: it spends current-context tokens,
  so large SKILL.md bodies are poor `load` candidates.
- `fork` — heavy or risky work that benefits from an isolated context window
  and independent abort (orchestration sub-steps, anything that fans out).
- `inline` — TS orchestrators that programmatically dispatch waves/DAGs.

## Scope (v1)

**In:** the `load` value on `SkillMetadata.context`; the registry + plugin load
branches in `SkillExecutor`; frontmatter `context` parsing for plugin skills;
the execute-now framing header; a countable `mode: "load"` telemetry
discriminator; tests.

**Out (deferred):**

- **Tool-scope injection** from `allowed-tools` frontmatter — v1 load skills run
  with the *current* tool set. (v2.)
- **Migrating existing fork skills → load.** That is a separate,
  behavior-preserving `/refactor` once the capability has soaked.
- Auto-relevance triggering, mid-turn permission re-scoping.

## Notes / invariants

- Default stays `'inline'`; the five inline TS skills and the fork path are
  untouched. `load` is strictly opt-in.
- The `execute()` depth guard applies to `load` too (conservative): a load
  dispatch at `depth >= maxDepth` is refused even though load does not deepen
  nesting. Revisit if it proves limiting.
