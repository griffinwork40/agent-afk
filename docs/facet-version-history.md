# SessionFacet Version History

Full per-version change log for `FACET_VERSION` in `src/agent/facets/schema.ts`.
Consumers should filter on `facet_version >= N` to guard against older cached facets.

## v12 (#3182)

- `world_changes.files_written` now includes successful `patch_apply` calls (skip
  on `isError` or `dry_run`). Sessions that write files exclusively via
  `patch_apply` no longer trigger the `no_corroborating_evidence` downgrade.
  Evidence paths from `patch_apply` are also collected.
- `no_corroborating_evidence` now recognises common external-effects bash commands
  (`git push`, `gh pr create`, `gh pr merge`, `npm publish`, `pnpm publish`) as
  corroborating signals, but only when `isError` is false. A session that opens a
  PR without writing a local file is no longer downgraded.
- `extractRawToolInput` now persists `dry_run` and a bounded `changes_paths`
  projection for `patch_apply`, so evidence-path collection works in production.
- `world_changes.mutated` is documented as local-file-only (excludes
  `bashExternalEffects`).

## v11 (#2798 cont.)

- Added trace-backed downgrade reasons: `budget_exceeded_closure`,
  `iteration_cap_closure`, `truncated_closure`, and `subagent_budget_exhaustion`.
  All require trace data plumbed via `DeriveOptions.traceSignals`.

## v10 (#2798)

Added `outcome_downgrade_reason` — when a self-reported `fully_achieved` (Done) is
downgraded to `partially_achieved`, this field records the first matching signal:
`'deferred_items'`, `'no_corroborating_evidence'`, or `'compose_partial_nodes'`.
Omitted when no downgrade occurred.

## v9 (#2978)

Added `compose_partial_node_count` — partial DAG nodes summed across compose calls.
`compose_partial_nodes` keeps counting calls; this field counts nodes. Added
`partialNodeCount?: number` to `ToolEventInputSchema`; journal `tool_result` blocks
now persist `incomplete`, so journal-derived facets see the partial signal.

## v8 (#2970)

Added `compose_partial_nodes` — number of compose calls in which at least one node
succeeded with a partial result (soft-deadline wind-down, tool-use cap). Omitted
when zero. Added `incomplete?: boolean` to `ToolEventInputSchema`.

## v7 (#2777)

Added `outcome_source`, `tool_errors_total`, and required nullable
`yield_tracking.pr_url`; added `'unknown'` to `FacetOutcomeSchema`; replaced
inline `TERMINAL_STATE_RE` in derive.ts with the shared `parseTerminalState()`
parser; yield_tracking carry-forward on re-derive in store.ts. Public consumers
should filter on `facet_version >= 7` and inspect `outcome_source`; headingless
sessions now derive `outcome: 'unknown'`.

## v6 and earlier

Predates this history file. Inspect git log on `src/agent/facets/schema.ts` for
earlier changes.
