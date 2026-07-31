---
name: intent-lock
description: "Fires before multi-step work when the user's request contains ambiguous referents ('the text', 'her Y'), characterizations of unverified entities ('the meeting is substantive'), identity assumptions (which contact = the user), code-vs-runtime dual referents, or no task statement at all (a bare path, URL, noun phrase, or pasted trace). Emits a one-sentence interpretation lock for fast async correction; escalates when interpretation gates an irreversible action AND multiple plausible reads exist."
context: load
---

## When to invoke

Check for these signal classes before starting any multi-step task:

**Ambiguous referents** — a noun phrase that could resolve to more than one entity in context:
- Bare demonstratives with no prior binding: "the text", "the doc", "that email", "the file"
- Possessives pointing to unintroduced people: "her draft", "their proposal", "his calendar"
- Ordinals with unclear basis: "the first one", "the latest version", "the other branch"

**Unverified characterizations** — a status or quality claim about a named entity the agent cannot confirm:
- "The meeting is substantive" (agent has not read the meeting)
- "The PR is approved" (agent has not checked)
- "The last run passed" (agent has not run or read CI output)

**Identity assumptions** — who is "the user", "me", "us", "the team", or a named person when the identity matters for action:
- Sending to "me" when multiple contact entries exist
- Filing under "my account" when credentials are ambiguous
- "The owner" when ownership is not established in context

**Code-vs-runtime dual referent** — a term that names an entity in the active codebase AND a model runtime concept. Fires when the user is working on a tool whose vocabulary mirrors the agent's own runtime (parity-mirror projects like agent CLIs, plugin frameworks, or harness tooling):
- "memory" — the project's memory store OR the agent's own session memory
- "session" — a project's session class OR the agent's conversation
- "hooks" — the project's hook registry OR the agent's tool-use hooks
- "agent" / "subagent" — the project's agent abstraction OR the agent dispatching them
- "tool" / "skill" / "plugin" — the project's loadable units OR the agent's available tools
- "MCP" / "terminal" / "REPL" — primitives the project implements that the agent also has

**No task statement at all** — the request is a bare fragment with no imperative verb, so the referent to resolve is the *goal itself* rather than a noun inside it:
- A lone path, repo URL, or issue/PR link with no stated ask
- A bare noun phrase: "the 429s", "usage indicators", "that timeout"
- A continuation cue whose carried-over goal is not uniquely established: "same as before", "and the 429s?"
- A pasted error, log line, stack trace, or diff with no question attached

**Skip when:**
- Referent resolves unambiguously from immediately prior context (file was just read this turn, entity was named and confirmed, prior message established the binding).
- Request is reversible, exploratory, and any misread is immediately correctable without cost.
- User has already provided the interpretation explicitly ("I mean X by 'the text'", "agent-afk's memory", "my session", "this codebase's hooks").
- Single-step clarification would cost more than simply proceeding and correcting.
- Dual-referent term has no matching symbol in cwd — no parity risk, standard interpretation applies.
- Fragment's goal is fixed by the immediately prior turn (agent just proposed two options and the user named one) — the task statement carries over intact.

---

## Procedure

### Step 1 — Scan

Before acting, scan the request for signal classes above. List every ambiguous referent, unverified characterization, identity assumption, code-vs-runtime dual referent, or missing task statement found. If zero are found, skip this skill entirely.

**When the finding is a missing task statement**, reconstruct the candidate goal from ambient evidence before classifying it — recent commits, branch name, open diff, the named file's contents, the prior turn. Cite the evidence the reconstruction rests on, so a wrong read is visibly wrong rather than silently load-bearing. Resolve this in-context; dispatch one sub-agent with one focused reconstruction question only when in-context reasoning cannot produce a single confident reading, and do not permit a follow-up dispatch. The reconstructed goal is then classified by Step 2 exactly like any other finding.

### Step 2 — Classify each finding

For each finding, determine:

- **Plausible reads** — how many distinct interpretations exist given available context?
- **Gate type** — does this interpretation gate a reversible or irreversible action?

### Step 3 — Choose resolution mode

| Condition | Mode |
|-----------|------|
| Single plausible read, reversible action | **Lock** — emit interpretation, proceed |
| Single plausible read, irreversible action | **Lock** — emit interpretation, proceed (but flag) |
| Multiple plausible reads, reversible action | **Lock** — emit most-likely read with explicit note, proceed |
| Multiple plausible reads, irreversible action | **Asking** — stop, ask one question |

Use **Asking** only when the current surface can receive an answer. On a daemon, scheduled, one-shot, or other non-interactive surface, multiple plausible reads that gate an irreversible action require **Blocked** — take no action and record the exact question whose answer would unblock it.

**Multiple plausible reads** means two or more interpretations that would produce materially different outcomes. "the text" pointing to one of two equally recent documents = multiple. "the text" when only one document was discussed this session = single.

### Step 4 — Emit the lock

**Lock format (most cases):**

> Interpreting: [ambiguous phrase] → [resolved referent]. Proceeding on that basis — correct me if wrong.

One sentence. No preamble. Append to the start of the work output, not as a standalone turn. The user can correct asynchronously; work continues.

**Lock format (reconstructed goal):**

> Reading [fragment] as: [reconstructed task statement] (from [evidence]). Proceeding on that basis — correct me if wrong.

**If multiple locks needed:** stack them, one per line, before the work output.

**Asking format (irreversible + multiple reads only):**

> [One precise question that resolves the ambiguity.] (This determines [what action follows].)

One question. State what it unlocks. Do not proceed until answered.

---

## Interaction with other skills

**thesis-lock** fires on first-person thesis before drafting. Intent-lock fires on the user's *request* before any multi-step work. They are complementary: thesis-lock protects the agent's own claims; intent-lock protects the agent's reading of what the user asked.

**ground-state** fires before implementation to survey repo state. Intent-lock fires before *any* multi-step work on requests with ambiguous inputs — including non-implementation work like drafting, research, or messaging. They can both fire on the same request (ground-state runs after intent-lock resolves).

In agent-afk, the `ask_question` hook enforces the reachability rule; where that hook is absent, apply the rule inline. Never emit an unreachable question: on a non-interactive surface, proceed only on a safe assumption or end Blocked without acting when the next action is irreversible. **trajectory-check** is a user-scope skill that may not exist in this installation — reference it only if present, and never block on it. When a session-end goal-vs-execution check is wanted, invoke it with the locked statement from Step 4 as its canonical-goal input, not the original fragment. Do not reimplement that check here.

**premise-gate** checks named-entity and status-claim pairs during research and analysis. Intent-lock fires *before* work begins on the request itself. They address the same underlying hazard at different points in the pipeline: intent-lock at request intake, premise-gate during execution.

---

## Exit criteria

- Every ambiguous referent, unverified characterization, identity assumption, code-vs-runtime dual referent, and missing task statement is either locked (one-sentence interpretation emitted), escalated to Asking, or ended Blocked on a non-interactive surface.
- A reconstructed goal is never acted on silently — the lock names both the reading and the evidence it rests on.
- No multi-step work begins on a request whose interpretation gates an irreversible action when multiple plausible reads exist.
- On a non-interactive surface, an unresolved interpretation that gates an irreversible action ends Blocked with no action and the exact unblock question recorded.
- Lock statements are visible in the turn output before the work they govern.
- Asking state contains exactly one question and states what it unlocks.
