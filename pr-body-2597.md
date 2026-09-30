Refs #2597

Addresses the concrete, low-risk advisory findings from the 2026-09-29 `/pr-triage` pass on PRs #2571–#2575. All speculative, architectural, or design-decision findings are listed below with the reason they were skipped.

## What changed

### `src/whatif/redundancy.ts` (finding: #2571 stemmer bug)
- **Stemmer guard fix:** raised the `-ings` length threshold from `> 6` to `> 7`, preventing `"strings"` (7 chars) from stemming to `"str"` via the `-ings` rule. It now falls through to the `-s` rule, correctly producing `"string"`.
- **`-ing` guard fix:** raised the `-ing` length threshold from `> 6` to `> 7`, preventing `"running"` (7 chars) from stemming to `"runn"`. It now passes through unstemmed, which is appropriate for this intentionally conservative stemmer.
- **Duplicate section header removed:** the second `// Token helpers` header (~line 90) was renamed to `// Tokenization`, eliminating the duplication flagged by the advisory.

### `src/agent/afk-gate-preview.ts` (finding: #2573 budget precondition undocumented)
- Added explicit JSDoc documentation for the `budget <= 0` edge case in `previewInput`, explaining that it falls through the `half <= 0` guard and returns `s.slice(0, budget)` (empty string for `budget === 0`). Callers are documented as expected to pass a positive budget.

### `src/agent/providers/openai-compatible/query.ts` (finding: #2575 missing `@internal`)
- Added `/** @internal */` JSDoc annotations to the six package-visible fields and one method that were promoted from `private` to satisfy the extracted `query/` context interfaces: `client`, `opts`, `toolDispatcher`, `traceWriter`, `fastTier`, `priorTurns`, `journal`, `lastUsage`, and `activeOpenAITools()`.

### `src/telegram/elicitation-telegram.test.ts` (finding: #2573 test-coverage gap)
- Added a test for the `_harnessInternal: true` + `title: undefined` case, verifying that the `⚠ AFK safety approval` fallback banner is rendered. This was the only uncovered branch in the Telegram spoofing-guard path.

### `src/agent/providers/openai-compatible/query/repair-orphan-tool-calls.test.ts` (finding: #2573 test-coverage gap)
- Added the reversed-interleaving test for the mixed Ollama/correlated case: input order `[user, assistant{c1,c2}, toolResult(c1), ollamaTool]`. Confirms that undefined-id messages are always emitted before id-correlated ones regardless of their position in the input run.

### `src/agent/journal/reader.async.test.ts` (finding: #2572 test-coverage gap)
- Replaced the weak fd-leak test (a 20-scan concurrency heuristic with unused `vi` import) with a spy-based assertion using `vi.spyOn(fs.ReadStream.prototype, 'destroy')`. Now directly verifies that `stream.destroy()` is called after each scan — the structural guarantee that no fd is leaked. The unused `vi` import is now used.

## Skipped findings (with reasons)

| Finding | Source | Reason skipped |
|---|---|---|
| `keychain.ts:~53` failure throttle | #2573 | Marked "medium (waived)" in the issue — the no-cache-on-failure behaviour is intentional and was explicitly waived at merge time. Adding a throttle is a design decision. |
| `query/compact-handler.ts:~158` `isClosed: ctx.closed` snapshot vs. `() => boolean` | #2575 | Marked "nit (inherited)" — changing the `compactOpenAIHistory` signature to accept a getter would be a non-trivial interface change requiring coordinated updates across callers. Low-impact; deferred. |
| Restore `Invariant:`/`Contract:` comments from old `query.ts` | #2575 | Requires auditing the pre-split file (no longer on main) against each new file. Speculative without knowing which load-bearing comments were omitted; deferred for a dedicated pass. |
| `findToolResultAsync` shared named return type with sync path | #2572 | Marked "nit" — adding a shared type alias is a non-breaking refactor with no correctness impact. Can be done in a follow-up. |
| `src/whatif/run.ts:~147` O(n²) Jaccard timing via `onProgress` | #2571 | Marked "low · perf suggestion" — emitting elapsed time requires threading the `onProgress` callback through to `checkRedundancy`. A design decision about the API surface. |
| Move `resolveOverloadPauseCeilingMs`/`nextProbeDelayMs` to `providers/shared/` | #2574 | Architectural refactor: moving these helpers would change import paths across multiple files and requires a re-export shim for backwards compatibility. Too risky for a nit-fix PR. |
| Integration test for close-during-pause through `runTurnInner` | #2574 | Complex to write correctly (requires timing coordination and mock infrastructure). Speculative — existing unit coverage of `runIterationWithOverloadPause` is solid. |

## Verification

```
pnpm install
pnpm test src/whatif/redundancy
pnpm test src/agent/afk-gate-preview
pnpm test src/telegram/elicitation-telegram
pnpm test src/agent/providers/openai-compatible/query/repair-orphan-tool-calls
pnpm test src/agent/journal/reader.async
pnpm lint
pnpm audit:filesize:check
pnpm audit:funcsize:check
```

All 6 test files pass. `tsc --noEmit` is clean. File-size and function-size checks pass (no new violations).
