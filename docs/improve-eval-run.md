# `afk improve eval-run` — deterministic validation

`afk improve eval-run <evalCaseId|cardSlug>` loads an eval-case and runs
deterministic checks that the failure it records is actually handled by the
current code. No LLM, no patch/apply, no git. It exits non-zero on a
regression so it can gate scripts (`afk improve eval-run X && …`).

It writes an `EvalRun` triple under `$AFK_HOME/agent-framework/improve/eval-runs/`
(`<id>.json` + `<id>.md` + an `.index.jsonl` append) and prints a check table.

## Two validation layers

A single run can contribute checks from two layers.

### 1. Guardrail-presence (`contracts.ts`)

For each supported pattern, the smallest deterministic probe that the guardrail
the pattern maps to **exists and behaves** — e.g. building a throwaway
`SessionToolDispatcher` and asserting the repeat-loop circuit breaker trips at
its threshold. This is generic: it proves a guardrail is present, not that it
covers any specific recorded failure.

| Pattern | Guardrail validated |
|---|---|
| `repeated-tool-use` | repeat-loop circuit breaker |
| `subagent-block` | skill max-depth recovery hint |
| `tool-failure-density` | detector enabled by default |
| `closure-anomaly` | abort-closure recovery hint |

### 2. Fixture-replay (`replay.ts`) — "is the behaviour fixed?"

For patterns with a registered replay handler (**currently `repeated-tool-use`
only**), the runner re-drives **this card's actual recorded failure** through
the live guardrail and asserts it would not recur at the recorded magnitude.

This is the layer that distinguishes *"a guardrail exists"* from *"this
failure is fixed."* It is strictly stronger than the presence check because it
is bound to the recorded tool and loop length — it catches, for example, a
guardrail whose threshold was raised above the magnitude the failure actually
reached, or a tool that the guardrail does not cover.

#### Why not "re-scan the fixture and expect zero findings"

The eval-case's stored assertion reads literally as *"replay the fixture
through the detector after the fix lands and expect zero findings."* That can
**never pass**: a detector is a pure function of the trace bytes, and the
committed fixture is an immutable byte-identical recording. Fixing code does
not rewrite an old trace, so re-scanning the static fixture always reproduces
the original finding. A naive rescan therefore cannot tell fixed from unfixed —
which is exactly why this layer does something else.

#### What it actually does

1. **Reproduce.** Parse the committed fixture and run the detector to confirm
   it still encodes the recorded pattern (and to extract the recorded
   `toolName` + `runLength`).
2. **Re-drive.** Feed that recorded loop's shape (byte-identical calls to the
   recorded tool, bounded to the breaker threshold) through the **live**
   `SessionToolDispatcher` and observe whether the circuit breaker trips at or
   before the recorded length.

| Outcome | `replay:` checks | Run verdict |
|---|---|---|
| Reproduces **and** guardrail neutralises the loop | reproduces ✓, neutralised ✓ | `pass` — fixed |
| Reproduces **but** guardrail does not neutralise it | reproduces ✓, neutralised ✗ | `fail` — still reproduces |
| Fixture intact but no longer encodes the pattern | reproduces – (skipped) | `unsupported` — **never `pass`**; the card-specific behaviour was not verified, even though the guardrail contract passed |
| Fixture missing / sha256 mismatch | (no replay) | `fail` via `fixture-integrity` before any replay runs |

#### Boundary (no overclaiming)

The replay re-drives the recorded loop **shape** (tool name + consecutive
byte-identical count), not the original tool or LLM execution. It proves the
live guardrail covers the recorded failure; it does not prove the loop can
never arise for an unrelated reason. The fixture bytes are checksum-pinned by
the eval-case, so the stimulus is stable across runs and the whole check is
deterministic.

## Status precedence

`error` > `fail` > `unsupported` > `pass`. Any failing check forces `fail`; a
contract or replay that throws forces `error`; `skipped` checks never force a
non-pass on their own.

`unsupported` is reached two ways: an eval-case whose pattern has no validation
at all (no guardrail contract and no replay handler), **or** a pattern that has
a replay handler whose replay was skipped (intact fixture that no longer
reproduces the loop). The second case is deliberate: when a replay is expected
but cannot run, the card-specific behaviour was never verified, so the run must
not report `pass` — a guardrail-presence-only result must never be mistaken for
behavioural proof. `pass` therefore means *the strongest validation available
for the pattern actually ran and passed* (a real neutralise result for
`repeated-tool-use`; guardrail presence for patterns without a replay handler).

## Adding a replay handler for another pattern

1. Implement an `async` handler `(evalCase, fixtureBytes, ctx) => { checks, evidence }`
   in `src/improve/eval-run/replay.ts` that re-drives the recorded failure
   through the **production** guardrail symbol (import it; never re-implement).
2. Register it in `REPLAY_HANDLERS` keyed on its `patternId`.
3. Emit a reproduce check and a neutralise check, both prefixed `replay:`.
4. Add a committed fixture under `src/improve/eval-run/__fixtures__/` and a
   fixture-backed test asserting the gate flips: real guardrail → `pass`,
   stripped guardrail → `fail`.

## Scope (not yet built)

This is step 1 of automating the improve pipeline. It does **not** apply fixes,
classify root causes with an LLM, auto-triage cards, or bridge into the
harvest → distill → forge loop. Those are deliberately deferred.
