# Proposal: Capture Parent→Child Subagent Prompts

**Status:** Design **superseded in part** by §8 after adversarial review (2026-08-01). Read §8
before implementing — the capture seam and the trace-event addition both changed. Branch
`afk/track-agent-prompts` is byte-equal to `main`.
**Author:** Scoped via parallel read-only sub-agent recon + main-session verification, 2026-08-01
**Revised:** 2026-08-01 after a 3-lens `/devils-advocate` critique wave + inline claim verification (§8)
**Scope (revised):** `src/agent/session/agent-session.ts` (1 line), `src/agent/session/subagent-prompt-capture.ts` (new), `src/paths.ts`, `src/config/env.ts`, `AFK.md`

---

## 1. Recommendation (one sentence)

> **SUPERSEDED — see §8.** The seam moved from the parent's handle to the child's own
> session, and the new trace event kind was cut. §§2–4 remain accurate as evidence; §5's
> touch list is replaced by §8.4.

~~Capture the full prompt at `SubagentHandleImpl.run()`~~ — the single place every dispatch
path passes a complete prompt — persist each dispatch as a **redacted markdown sidecar,
one file per dispatch**, inside the session's existing witness directory, ~~indexed by a new
`subagent_prompt` trace event; render the per-session `prompts.md` from the sealed trace
at SessionEnd~~ rather than appending to a shared markdown log live.

## 2. What exists today, and the actual gap

The witness trace already carries a prompt slice, but it is nearly useless for this purpose:

| Artifact | Prompt content today | Evidence |
|---|---|---|
| `subagent_lifecycle.started` → `promptHead` | first **80 chars**, `.slice(0,80).trim()` | `src/agent/trace/types.ts:225-240`; sliced at `src/agent/tools/subagent-executor.ts:621` |
| `subagent_lifecycle.started` → `systemPromptHash` | SHA-256 digest only, no text | `src/agent/trace/types.ts:232` |
| `tool_call.started` → `inputBytes` | a byte count, never the args | `src/agent/trace/types.ts:44-51` |
| session ledger `events.jsonl` | `summarizeToolInput` has **no `prompt` branch** → `''` for the `agent` tool, and caps at 400 chars | `src/agent/tool-input-summary.ts:44-87`; `src/agent/session-ledger.ts:91,109-116` |
| transcripts `~/.afk/state/transcripts/*.md` | parent `## User` / `## Assistant` turns only — no tool calls, no subagent activity | `src/cli/commands/interactive/transcript.ts:87,96,106` |

`AFK.md:51` already documents the family gap ("tool **args** live in
`~/.afk/state/sessions/<id>/events.jsonl`, not the witness trace"), and
`docs/audits/failure-geometry-audit.md:195-199` carries it as unclosed audit debt.

**Worse than "truncated": `promptHead` is absent on most dispatch paths.** Only the `agent`
tool populates it. Verified coverage:

| Dispatch path | Emits `subagent_lifecycle.started` | `promptHead` populated |
|---|---|---|
| `agent` foreground | yes (`subagent-executor.ts:588`) | **yes** (`:621`) |
| `agent` background | yes (same call) | **yes** |
| `agent` + `isolation:"worktree"` | yes (falls into the same call) | **yes** |
| `compose` / DAG nodes | yes (`dag-subagent.ts:101`) | **no** |
| `skill` forks | yes (`fork-dispatch.ts:339`, `user-skills.ts:185`) | **no** |
| mint phases, audit-fit, farm-via-DAG | yes (direct `forkSubagent`) | **no** |

## 3. Chokepoint analysis — why `run()` and not the obvious candidates

`forkSubagent()` (`src/agent/subagent.ts:600`, self-documented as "the single choke point"
at `:771`) is the chokepoint for the *lifecycle event* — but **the prompt is not in scope
there**. `ForkSubagentOptions` has no full-prompt field; it carries only the pre-sliced
`promptHead?: string` (`src/agent/subagent.ts:273`, whose own doc comment says "The prompt
itself is not a `forkSubagent` argument — it arrives later via `handle.run(prompt)`").

The prompt arrives on the **handle that `forkSubagent` returns**, and all three entry
methods funnel through one function:

- `run(prompt, sinkOverride?)` — `src/agent/subagent/handle.ts:197`
- `runToResult()` → `await this.run(prompt, sinkOverride)` — `handle.ts:611,613`
- `runInBackground()` → `void this.runToResult(prompt, sinkOverride)` — `handle.ts:642,659`

So `handle.run()` is the true single chokepoint, and it already has everything needed for
attribution in scope, with no new plumbing: `prompt` (full), `this.id`, `this.parentId`
(`handle.ts:118`), `this.agentType` (`:162`), `this.session`, `this.traceWriter` (`:165`).
It is already a trace emission site — `emitSessionPhase` fires at `handle.ts:226`.

Rejected alternatives:

- **Widen `promptHead` to a full prompt on `started`.** Requires threading the prompt
  through 6+ call sites that currently pass nothing, and the value still isn't in scope at
  the emit. Capturing at `run()` covers compose/DAG, skills, mint, and audit-fit **for free**.
- **`SubagentStart` hook.** Payload is `{ event, subagentId, parentSessionId? }`
  (`src/agent/hooks.ts:159-163`) — no prompt, no model, no agent type, and it fires at
  `subagent.ts:647-660` *before the child receives a prompt*. Structurally cannot work.
- **Session ledger.** A deliberately summarized, 400-char-capped layer (`session-ledger.ts:91`).
  Wrong layer for verbatim text.

A further advantage of emitting from `run()`: a handle can be re-run sequentially
(`src/agent/subagent-multi-turn.test.ts`), so **one event per run** captures every turn's
prompt, which a single field on `started` structurally cannot.

## 4. Storage decision: markdown per dispatch, index derived

Markdown is the right *format*, but a single shared markdown log is the wrong *store*:

1. **Parallel waves interleave.** A 5-wide fan-out appends concurrently; safe appends need
   the serialized promise queue `writer.ts:246-259` already implements. Don't rebuild it.
2. **No exit backstop.** The trace writer has a synchronous process-exit flush
   (`writer.ts:145-153,304-338`); a naive markdown appender loses the tail on a hard exit.
3. **No schema for attribution.** parent/child ids, model, agent type, turn index need
   structure, not prose.

**One markdown file per dispatch** avoids all three — no interleaving is possible, YAML
frontmatter supplies the schema, and the body stays byte-verbatim (prompts are full of code
fences and `---`; only the leading frontmatter delimiters are parsed, so the body needs no
escaping). This mirrors the existing sidecar precedent: `persistCompactionSidecar`
(`src/agent/trace/writer.ts:380-411`) already writes oversized payloads to
`<traceDir>/<seq>-<ts>-*.json` and stores a `{ path, sizeBytes, sha256 }` ref in the JSONL line.

The per-session rollup is **derived from the sealed trace**, exactly like the run receipt
(`renderReceiptMarkdown` at `src/agent/trace/receipt.ts:393`, `writeRunReceipt` at `:499-524`,
wired via a SessionEnd hook at `:536-551` and gated by its own disable flag). Deriving from
the seal means the rollup can never be half-written or interleaved.

### Layout

```
~/.afk/state/witness/<session>/
  trace.jsonl                          # + new `subagent_prompt` records indexing the sidecars
  prompts/
    000012-research-agent-…-1.md       # one file per dispatch; writer `seq` prefix = emission order
    000019-general-…-2.md
  prompts.md                           # rendered at SessionEnd from the sealed trace
```

Sidecar file shape:

```markdown
---
subagentId: research-agent-1785607832551-1
parentSessionId: cli-2026-08-01T18-02-11
agentType: research-agent
model: claude-sonnet-4-6
turn: 1
seq: 12
ts: 2026-08-01T18:04:11.223Z
promptBytes: 2481
sha256: 9f2c…
truncated: false
redacted: true
---
<verbatim prompt text>
```

Mode `0o600`, matching transcripts (`transcript.ts:18`, "may contain secrets").

**What gets logged is the composed message the child actually received** — compose's
`<<<UPSTREAM_OUTPUT_BEGIN/END>>>` wrapping (`compose-executor.ts:686-707`) and the skill
fork anchor (`fork-dispatch.ts:355-357`) are already applied by the time `run()` sees it.
That is the forensically correct choice ("what did the child actually see"). Capturing the
caller's *pre-wrap* intent as a second field is deferred (§7).

## 5. Implementation plan

The 350-LOC rule forces new concerns into new files — `handle.ts` is already 843 LOC and
`subagent.ts` is 1165 LOC, so neither absorbs this logic.

| # | File | Change | Est. LOC |
|---|---|---|---|
| 1 | `src/agent/trace/prompt-capture.ts` | **new.** `capturePrompt({ writer, subagentId, parentId, agentType, model, turn, prompt })` — redact → cap → write sidecar → emit event. Fire-and-forget, swallows write errors (matches `emit.ts:1-18`). | ~130 |
| 2 | `src/agent/trace/prompt-report.ts` | **new.** `renderPromptsMarkdown(sealedTrace)` + `writePromptsReport()`, SessionEnd-hook wired beside the receipt. | ~150 |
| 3 | `src/agent/trace/types.ts` | add `'subagent_prompt'` to the kind union + `SubagentPromptPayload { subagentId, parentId?, agentType?, model?, turn, promptBytes, sha256, ref: { path }, truncated, promptHead }` | ~25 |
| 4 | `src/agent/trace/events.ts` | zod schema for the new payload | ~15 |
| 5 | `src/agent/trace/emit.ts` | `emitSubagentPrompt(writer, payload)` | ~10 |
| 6 | `src/agent/subagent/handle.ts` | **one** `void capturePrompt({…})` call in `run()` before the provider call | ~6 |
| 7 | `src/paths.ts` | `getPromptsDir(sessionId)` beside `getTraceDir` (`:311`) / `getReceiptsDir` (`:340`) | ~4 |
| 8 | `src/config/env.ts` | `AFK_PROMPT_CAPTURE_DISABLED` getter + `ENV_REGISTRY` entry (required by `env.ts:38-44`), then `pnpm scan:env` | ~12 |
| 9 | `src/cli/commands/trace.ts` | `trace.command('prompts [session]')` beside `show` (`:742`) / `list` (`:785`) | ~60 |
| 10 | `AFK.md:51`, `docs/architecture.md` | close the documented known-gap line | ~10 |

Tests follow existing conventions: `InMemoryTraceWriter` for emission
(`src/agent/trace/subagent-lifecycle.test.ts:135`), tmpdir + `process.env['AFK_HOME']`
override for the CLI (`src/cli/commands/trace.test.ts:20-21`).

### Safety knobs

- **Redaction:** `redactInlineSecrets()` (`src/agent/session/prompt-dump.ts:106`) — built for
  exactly this ("this may contain the system prompt, redact before writing"). Layers over the
  general primitive `redactSecrets()` (`src/agent/redact-secrets.ts:48`).
- **Cap:** 64 KB per prompt, truncate with an explicit marker and record
  `truncated: true` + `originalBytes` — never silently.
- **Gating:** `AFK_PROMPT_CAPTURE_DISABLED`, default **enabled**, matching the
  `AFK_TRACE_DISABLED` / `AFK_SESSION_LEDGER_DISABLED` / `AFK_RUN_RECEIPT_DISABLED`
  convention (`env.ts:1091-1119`). Also inert whenever the trace writer is absent.

## 6. Verification

`pnpm lint`, `pnpm test`, plus the CI gates `pnpm audit:env:check` and `pnpm scan:env:check`
(both mandatory for the new env var — `.github/workflows/ci.yml:50-94`). End-to-end check:
run a `compose` DAG and a `skill` dispatch, then confirm both appear in
`~/.afk/state/witness/<session>/prompts/` — these are the paths that record **nothing** today,
so they are the real regression signal.

## 7. Deferred

- **Child system prompts** — hash-only today (`types.ts:232`); the sidecar mechanism makes
  full capture a small follow-up, but system prompts are large and mostly static.
- **Caller pre-wrap intent** as a second field alongside the composed message (§4).
- **Retention/pruning** — inherits whatever reaps `~/.afk/state/witness/`; no new policy here.
- **A function-scoped file-size gate** (open issues #831/#832) — unrelated, but these new
  files should land well under the ceiling regardless.

---

## 8. Revision after adversarial review (2026-08-01)

A 3-lens `/devils-advocate` wave (pragmatist / paranoid / architect, each un-anchored — none
were shown this document) produced one `strong` and two `medium` alternatives. Every
load-bearing claim was then re-verified inline. Two of the critique's premises were refuted
and one component of this proposal was rejected by **all three** lenses independently.

### 8.1 Verified facts (measured or quoted, 2026-08-01)

| Claim | Verdict | Evidence |
|---|---|---|
| Child sessions share the parent's identity | **CONFIRMED** | `subagent.ts` invariant: *"A child resumes the parent's sessionId and writes into the SHARED parent trace file"* |
| The whole tree shares one trace writer | **CONFIRMED** | `subagent.ts`: *"The whole tree shares ONE TraceWriter by reference"* |
| `isSubagentFork` is stamped on every fork | **CONFIRMED** | `subagent.ts:807`, *"this is the single choke point every fork path converges through, so no fork path can forget it. A caller override is intentionally NOT honored"* |
| `ownsTraceSeal` trusts that same flag | **CONFIRMED** | `src/agent/session/agent-session.ts:184-186` |
| `sendMessageStreamInternal` is the in-session chokepoint for inbound messages | **CONFIRMED** | `agent-session.ts:646`; both callers converge — collect path `:556`, stream path `:640` |
| The session ledger already records child prompts | **REFUTED** | `ledger-lifecycle.ts:56` `if (ctx.depth !== undefined \|\| ctx.parentSessionId !== undefined) return;` — comment at `:26`: *"Subagent-fork markers — either being set gates the ledger off."* Also `recordUser` clips to `MAX_TEXT_LEN` (`session-ledger.ts:213-214`) |
| `emitSubagentLifecycle` no-ops without a writer | **CONFIRMED** | `emit.ts:64` `if (!writer) return;` — but the shared-writer invariant above reduces this to "only when tracing is deliberately disabled" |
| Nothing prunes the witness tree | **CONFIRMED** | `log-retention.ts::capJsonlBySize` is wired only to `session-grants.jsonl` |
| Witness tree size today | **MEASURED** | **12,596 directories / 461 MB** (`ls \| wc -l`, `du -sh`) |
| Critic's cited path `src/agent/agent-session.ts` | **REFUTED** | actual file is `src/agent/session/agent-session.ts` (1345 LOC); its line numbers were correct |

### 8.2 What changed, and why

**Cut the new `subagent_prompt` trace event kind.** All three lenses rejected it
independently: it permanently grows `TraceEventKind` — consumed by `receipt.ts`, `trace.ts`,
`insights/aggregators/traces.ts`, and tests — to serve one operator's forensics need. The
directory of per-dispatch files is its own index; the frontmatter carries the correlation
ids. This also removes the dependency on a wired `TraceWriter` (`emit.ts:64`).

**Move the seam from the parent's handle to the child's own session.** `handle.run()` and
`sendMessageStreamInternal` are near-equivalent on coverage — both sit downstream of every
prompt transformation and both catch all six paths and multi-turn. The child-side seam wins
on three smaller margins: it needs no knowledge of the handle abstraction, it sits beside an
existing analogous instrumentation point (`ledger.recordUser`, `agent-session.ts:674`) that
forks are *deliberately* gated out of, and it survives any future dispatch mechanism. The
LOC argument is a wash and is not claimed: `agent-session.ts` (1345 LOC) is further over the
350 ceiling than `handle.ts` (843 LOC); the win is that in both cases the *concern* lands in
a new file, and this version adds 1 line instead of 6.

**The scattering objection dissolved.** The architect lens worried a child-side capture would
key artifacts by the child's session id, scattering one parent's dispatches. Refuted: a child
*resumes the parent's sessionId*, so `getTraceDir(this.sessionId)` inside a child already
resolves to the parent's witness directory, while `config.subagentId` (stamped per fork)
supplies the filename. Both identities are in scope at the seam.

**Default-on became opt-in.** With 12,596 unpruned witness directories and no retention
mechanism anywhere over that tree, a default-on per-dispatch file is not defensible. Precedent
for an off-by-default capture flag: `AFK_BROWSER_DOM_SNAPSHOTS`.

**Cap before redact, not after.** Redaction is regex-based; running it first pays full cost on
an oversized paste that is about to be truncated anyway. Cap to 8 KB (prompts in this repo run
1–4 KB), then redact.

**Residual risk accepted, not solved.** `redactInlineSecrets` catches only named-shape secrets
(`prompt-dump.ts:72-100`); it structurally cannot catch `postgres://user:pass@host` URIs, PEM
blocks, or PII. Mitigating context: `interactive/transcript.ts` already writes full user turns
to disk at `0o600` with **no** redaction call, so this risk model is pre-existing and the
marginal exposure is an extension of it. Keep a `DUMP_FILE_BANNER`-style warning in the file
rather than implying safety.

### 8.3 Retry orphaning (pre-existing, worth recording)

The stream-cut-retry work (`24ed8d14`, `b90271e0`, `19e0ae22`) is **not** an ancestor of this
branch's HEAD, so it does not affect the code under review. When it lands: each retry attempt
forks fresh (new id), so per-dispatch capture will orphan the failed attempt's prompt file
rather than duplicate or overwrite it — one logical dispatch counted twice. Acceptable, and
arguably desirable for forensics, but the rollup (if built) must not double-count.

### 8.4 Revised touch list

| # | File | Change | Est. LOC |
|---|---|---|---|
| 1 | `src/agent/session/subagent-prompt-capture.ts` | **new.** cap → redact → write `0o600` markdown w/ frontmatter. Mirrors `ledger-lifecycle.ts`'s shape. | ~120 |
| 2 | `src/agent/session/agent-session.ts` | **one line** beside `this.ledger.recordUser(...)` (`:674`), gated on `config.isSubagentFork === true` | 1 |
| 3 | `src/paths.ts` | `getPromptsDir(sessionId)` beside `getTraceDir` (`:311`) | ~4 |
| 4 | `src/config/env.ts` | `AFK_CAPTURE_SUBAGENT_PROMPTS`, **default off** + `ENV_REGISTRY` entry, then `pnpm scan:env` | ~12 |
| 5 | `AFK.md:51` | close the documented known-gap line | ~6 |

Path: `getTraceDir(sessionId)/prompts/<NN>-<subagentId>.md` — the parent's directory, verified
reachable from inside the child. **Cut from §5:** the new trace event kind (items 3–5 of the
original table), the SessionEnd rollup renderer, and the `afk trace prompts` CLI subcommand —
all deferred until the raw capture proves useful. Net: ~143 LOC across 5 files, down from
~420 across 10.

### 8.5 Known limitation found during implementation

Capture is fire-and-forget by contract — it must never delay or fail a turn — so the write is
not guaranteed to have landed the instant the child's turn resolves. In practice it lands
within milliseconds; on an immediate hard process exit the final prompt can be lost. The trace
writer solves this with a synchronous process-exit backstop (`writer.ts:145-153`); no
equivalent is built here, deliberately, because losing the last prompt of a session is an
acceptable failure mode for an opt-in forensics artifact and an exit hook is a materially
larger surface. `subagent-prompt-capture-wiring.test.ts` polls rather than sleeps so the
guarantee it asserts is "eventually lands", not a timing assumption.

### 8.6 Dissent

`dissent = false` — only one critic returned `strong`, and the recommendation adopts its seam.
Its two supporting arguments were nonetheless refuted (§8.1), so the seam is adopted on the
narrower grounds in §8.2, not on the strength label. The `/devils-advocate` Wave 3 synthesis
and Wave 3.5 boundary check were **not dispatched** — both died on provider rate limits; the
three composition boundaries they would have probed (shared trace writer, resumed session id,
seal ownership) were instead verified inline and are recorded in §8.1.
