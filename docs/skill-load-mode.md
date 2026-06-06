# Skill execution modes: `inline` / `fork` / `load`

Status: implemented (v1). Scope-frozen 2026-06-01.

> **Amendment 2026-06 — load-by-default for frontmatter skills.** The default
> execution mode for **plugin** SKILL.md skills and **user/project disk**
> skills (`~/.afk/skills/`, `<cwd>/.afk/skills/`) flipped from `fork` → `load`:
> a frontmatter skill now runs in-context unless it explicitly declares
> `context: fork`. Built-in TS registry skills are unaffected — they still
> default to `inline` (their handler is the orchestrator). Bundled skills that
> must return an **epistemically independent** result, or keep heavy
> intermediate work out of the main context, are pinned to `context: fork`
> (`research`, `ground-state`, `shadow-verify`, `review`, `simplify`,
> `refactor`, `ship`, `spec`). Skills that orchestrate *from* the current agent
> and feed their result back into the caller's decision stay `load`
> (`gather`, `parallelize`, `devils-advocate`), as do the zero-dispatch
> **guard** skills (`ground-claim`, `intent-lock`). See the "Defaults" section
> below.

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
| `inline` | run the TS `handler` in-process | current process | orchestrator skills (mint, forge, diagnose, audit-fit, score) |
| `fork` | fork a subagent with `prompts/system.md` / SKILL.md body as its system prompt | **isolated** child | Claude Code `Agent`/`Task` (delegation) |
| `load` | return `prompts/system.md` / SKILL.md body as the tool result; the **current** agent executes it with its existing tools | **current** session | Claude Code inline Skill (progressive disclosure) |

Defaults differ by skill kind — see the [Defaults](#defaults) section.

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

Plugin / user / project disk (`SKILL.md` frontmatter) — `load` is the default,
so the `context:` line is optional:

```markdown
---
name: my-skill
description: …
# context: load   # optional — load is the default for frontmatter skills
---
Your in-context operating procedure. May reference $ARGUMENTS and ${SKILL_ROOT}
(disk skills) / ${PLUGIN_ROOT} (plugin skills), expanded in-place before load.
```

To opt a frontmatter skill into delegation, declare `context: fork` explicitly:

```markdown
---
name: my-heavy-skill
description: …
context: fork
---
Body becomes the forked sub-agent's system prompt; runs in an isolated context.
```

## Defaults

The default execution mode depends on how the skill is defined:

| Skill kind | Source | Default when `context:` absent |
|------------|--------|--------------------------------|
| Built-in TS registry | `registerSkill({ … })` in `src/skills/` | `inline` (handler is the orchestrator) |
| Plugin | `~/.afk/plugins/*/SKILL.md` | **`load`** (since 2026-06) |
| User / project disk | `~/.afk/skills/`, `<cwd>/.afk/skills/` | **`load`** (since 2026-06) |

Rule for frontmatter skills (plugin + disk): **fork iff `context: fork`**;
everything else (absent, `load`, or an unrecognized value) loads in-context.
Built-in TS skills are unchanged — they still default to `inline`, and only
opt into `fork`/`load` explicitly.

Disk skills resolve their load body from the SKILL.md content (not the built-in
`prompts/system.md` convention), threaded through `SkillMetadata.loadBody`;
`${SKILL_ROOT}` is expanded to the skill's directory in-place at registration,
because load mode runs in the current agent (no subagent env injection).

Bundled skills shipped under `awa-bundled/` pinned to `context: fork`:
`research`, `ground-state`, `shadow-verify`, `review`, `simplify`, `refactor`,
`ship`, `spec`. These either return an **epistemically independent** result the
caller's reasoning must not contaminate (`shadow-verify`, `review`), or run
heavy multi-phase / high-volume work whose intermediate noise must stay out of
the main context (`research`, `ground-state`, `refactor`, `ship`, `simplify`,
`spec`).

Bundled skills that stay `load`: `gather`, `parallelize`, `devils-advocate`,
`contract`, `ground-claim`, `intent-lock`. These orchestrate *from* the current
agent and feed their result back into the caller's decision, or are pure
in-context guards.

### Choosing fork vs load (the rule that matters)

Do **not** use "does it dispatch sub-agents?" as the test — that is the crude
rule that mis-pinned `devils-advocate` and the guards. Ask instead:

- **Independence:** must the *result* be free of the caller's reasoning/bias?
  → `fork` (`shadow-verify`, `review`). Note: a skill can dispatch its own
  independent sub-agents *and still be `load`* — `devils-advocate` and
  `parallelize` fan out parallel waves, but the current agent orchestrates and
  the critics/synthesizer stay isolated as sub-agents either way, so `fork`
  would only add an orchestration layer, not independence.
- **Context hygiene:** would the intermediate work (voluminous reads, failed
  hypotheses, multi-phase logs) blow or pollute the caller's window? → `fork`
  (`research`, `ground-state`, `refactor`, `ship`).
- **Otherwise** — the skill advises, enriches, orchestrates, or guards the
  *current* turn, and its output is meant to land in the caller's context →
  `load` (`gather`, `parallelize`, `devils-advocate`, `ground-claim`,
  `intent-lock`). A zero-dispatch guard is ALWAYS `load`: a forked guard returns
  a digest about a context it cannot see, producing a false safety signal.

A 2026-06 /devils-advocate review (and a follow-up user review of that review)
moved `ground-claim`, `intent-lock`, and `devils-advocate` itself from the
initial fork pin to `load`.

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

- **Built-in TS registry skills** still default to `'inline'`; the five inline
  TS skills (mint, forge, diagnose, audit-fit, score) and the fork path are
  untouched.
- **Frontmatter skills** (plugin + user/project disk) default to `'load'` since
  the 2026-06 amendment: fork iff `context: fork`. Isolation-critical bundled
  skills are pinned to `context: fork` (see [Defaults](#defaults)); third-party
  plugins and disk skills that omit `context:` now load in-context. Authors of
  fan-out / heavy orchestration skills MUST set `context: fork` explicitly.
- The `execute()` depth guard applies to `load` too (conservative): a load
  dispatch at `depth >= maxDepth` is refused even though load does not deepen
  nesting. Revisit if it proves limiting.
