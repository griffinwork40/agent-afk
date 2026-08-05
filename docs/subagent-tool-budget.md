# The subagent tool-round budget preamble

Reference for `src/agent/subagent/budget-preamble.ts` — the module that
discloses a forked child's tool-use-round cap to the child itself.

This document carries the `History:`-class material (root cause, incident
record, decision log) that the long-comment convention in `AFK.md` keeps out
of the source. The rounds-vs-calls invariant and the fork-site contract stay
inline in the code as `Invariant:` / `Contract:` blocks.

## What the budget is

The cap meter is tool-use ROUNDS, not tool CALLS. A round is one assistant
turn that requests tools, so a turn issuing five parallel calls costs 1
round, not 5 — `providers/anthropic-direct/loop/tool-round.ts` and
`providers/openai-compatible/query.ts` both increment once per round, after
dispatching the whole batch. A child that batches independent calls into one
reply therefore buys roughly 10x the evidence per unit of budget compared
with one that calls tools one at a time.

## Why the child was never told

Until this module existed, nothing told the child any of that. The only
budget text that ever reached the model was `WIND_DOWN_NOTE`
(`providers/shared/tool-loop-cap.ts`), appended on the FINAL round — after
the budget was already spent, too late to change how the child paced itself.
The per-round `round 7/50` label produced by `formatRoundLabel` goes out on a
progress `ProviderEvent` consumed by terminal/UI renderers, and never enters
model history. The model that is actually doing the pacing never sees it.

So children paced blind: they averaged 1.6–3.0 tool calls per round, and
burned the full round budget (50, by default) on the evidentiary equivalent
of about 50 individual tool calls' worth of work — an order of magnitude
short of what the same round budget could buy if batched.

## The measured cost

296 of 4,671 forks capped (6.34%), $990 in a single telemetry window, with
the cap rate climbing week over week. That measurement is what motivated
writing this module rather than leaving the gap in place.

## Why injection happens at the provider-neutral fork site

This module is deliberately provider-agnostic and is applied at exactly ONE
site — `SubagentManager.forkSubagent`, the sole path to a child
`AgentSession`. Injecting here rather than inside a provider is what keeps
the two providers from drifting apart on this behavior.

The repo has already been burned once by exactly that failure: for a while,
`openai-compatible` shipped without the graceful wind-down that
`anthropic-direct` had already gotten, because the wind-down logic lived
inside the anthropic-direct provider instead of at a shared, provider-neutral
site. Every provider must render `systemPrompt` to function at all, so
injecting the budget preamble into `systemPrompt` at the fork site means no
provider has to separately cooperate, remember, or re-implement anything for
this to work — the same structural fix as the shared wind-down note.

## Where the block lands in the assembled prompt

`injectToolBudgetPreamble` appends the preamble block after any
caller-supplied `config.systemPrompt`, so within the fork's OWN prompt
literal the block sits last — operational trailer rather than mission,
keeping the child's actual instructions at top salience.

That is "last" only relative to the caller-supplied prompt, not last in the
prompt actually sent to the model. The fork's `config.systemPrompt` becomes
the `userSystem` argument to `assembleSystemPrompt`
(`providers/anthropic-direct/query/system-prompt.ts`, mirrored by the
equivalent assembly in `providers/openai-compatible/index.ts`), which places
`userSystem` at position 2 of 6 in the final prompt — after `toolBase`, and
before `memoryPrompt`, `hotMemory`, the `# Environment` fragment, and the
skill `manifest`. All of those later sections are appended AFTER the budget
preamble in what the model actually receives.

## Open gaps

- The runtime still has no non-convergence detector. The preamble's closing
  sentence ("If new evidence has stopped changing your conclusion, stop
  gathering and answer now.") is a prose stand-in for that missing
  mechanism, not a substitute with the same reliability — nothing today
  actually terminates a child whose queries keep varying while its
  conclusion stops changing.
- Post-merge, watch a metric pair, not a single number: the cap rate (forks
  hitting `tool_use_loop_capped`) should fall, but answer completeness must
  not fall with it. A drop in cap rate that comes from children truncating
  their investigation early to stay "under budget" would be a regression
  wearing the shape of an improvement.
