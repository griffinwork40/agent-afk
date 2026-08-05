# Anthropic Opus Fast mode

Fast mode is a session-scoped preference for eligible top-level Anthropic Direct turns.
Use `/fast on`, `/fast off`, or `/fast` to inspect status. Changes apply to the next
user turn; they never alter effort or the turn already in flight. A resumed interactive
session uses the controller owned by that live REPL process; the preference is not
persisted to disk.

## Eligibility

The preference becomes effective only when all of these are true:

- the resolved provider is Anthropic Direct;
- the resolved model belongs to anchored Claude Opus 5 or Opus 4.8 families;
- no custom Anthropic endpoint is configured; and
- execution is the top-level user turn.

Status explains unsupported provider/model, custom endpoint, or excluded execution
path. Child providers, subagents, skills, compaction, summarization, one-shot calls,
and auxiliary calls do not receive Fast intent. Switching to an ineligible model keeps
the preference enabled; switching back makes it effective again.

## Wire and failure behavior

Eligibility is snapshotted once at turn start. An effective turn sends both
`fast-mode-2026-02-01` in `anthropic-beta` and `speed: "fast"` in the request body.
Every tool-loop round and 503/529 retry reuses that decision. There is no automatic
standard-speed fallback: a rejection remains visible as a Fast request error and does
not disable the preference.

## Usage and pricing

Anthropic's observed response `usage.speed`, when present, is retained in completed
turn metadata. Cost selection prefers observed speed, then requested speed, then
standard pricing. Fast Opus pricing is $10/MTok input and $50/MTok output. Cache write
and read are accounted at the documented assumption of 1.25x and 0.10x Fast input
($12.50 and $1.00/MTok). Standard pricing and its historical formula are unchanged.
