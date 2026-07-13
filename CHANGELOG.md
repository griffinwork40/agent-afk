# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries in the [Unreleased] section may include a short commit hash suffix
(e.g. `- add thing (abc1234)`). The hash is used by `/changelog` and the
auto-release workflow to deduplicate commits across successive runs.

## [Unreleased]

## [5.36.1] - 2026-07-13

### Fixed
- restrict read-only depth-cap forks to declared tools + honor plugin model: (#499) (#542) (2f7dc7e)

## [5.36.0] - 2026-07-13

### Added
- Linux systemd --user support behind a platform-neutral ServiceManager (#515) (25bd80c)

## [5.35.3] - 2026-07-12

### Fixed
- inherit parent read scope for forked sub-agents (#544) (94298d7)

## [5.35.2] - 2026-07-12

### Fixed
- restore worktree cwd when resuming or forking a session (#535) (a1ea133)

## [5.35.1] - 2026-07-12

### Fixed
- stop redacting long filesystem paths as opaque secrets (#533) (57cb592)

## [5.35.0] - 2026-07-12

### Added
- openai-compatible: honor server `retry-after` / `retry-after-ms` on 429/503 backoff instead of blind exponential (parity with anthropic-direct) (#536)

### Added
- mirror source tool enabled/disabled state for imported plugins (#537) (2df91f4)
- honor retry-after on 429/503 backoff (#536) (#538) (e4e3bf2)

## [5.34.0] - 2026-07-12

### Added
- app-like TUI — /config settings menu + /model & /resume pickers (#506) (7cf6c0b)

## [5.33.2] - 2026-07-12

### Fixed
- guard NaN config + non-string systemPrompt + unmask registry-skill errors (#534) (edfcd64)

## [5.33.1] - 2026-07-12

### Fixed
- resolve path-approval grants per executing session (#435/#514) (#527) (01632cd)

## [5.33.0] - 2026-07-12

### Added
- observe-only release-boundary PreToolUse detector (gate-migration wave 1 slice 2) (#524) (7f5a4fc)
- cross-provider history compaction (#517) (d44cc30)

## [5.32.0] - 2026-07-12

### Added
- distinguish parallel vs sequential tool dispatch with ∥i/N batch badge (#520) (f617893)

## [5.31.2] - 2026-07-12

### Fixed
- give read/write/edit/list the factory-cwd resolve tier glob/grep have (#434) (#522) (a4be744)

## [5.31.1] - 2026-07-12

### Fixed
- flatten multi-line bash summaries in the tool-lane label (#511) (ea3b9c0)

## [5.31.0] - 2026-07-12

### Added
- auto-resume idle REPL when a background subagent completes (#518) (2a1d374)

### Changed
- bump @types/node from 26.1.0 to 26.1.1 in /website (#531) (7e1baef)

## [5.30.6] - 2026-07-12

### Changed
- dedupe runIteration's two wire branches (#365) (#525) (db03f41)
- unify system-prompt assembly into query/system-prompt.ts (#362) (#523) (5c5cf97)
- bump the fumadocs group in /website with 3 updates (#529) (be2459b)

## [5.30.5] - 2026-07-12

### Fixed
- classify AFK gate writes by tool cwd (port afk-workshop#836) (#512) (fd7e3ab)

## [5.30.4] - 2026-07-12

### Changed
- extract closure-emitter, ledger-lifecycle, plan-exit-bridge (#364) (#519) (040403a)

## [5.30.3] - 2026-07-12

### Fixed
- explicit writeRoots grant + truthful deny for forked children (#514) (360b999)

## [5.30.2] - 2026-07-11

### Fixed
- refresh lastMeasuredFrameTop in the picker repaint path too (#513) (0c83bfa)

## [5.30.1] - 2026-07-11

### Fixed
- label subagent tool-call tallies "N tool calls" not "N tools" (#508) (2f1c857)
- route commitAbove on the real measured frame top, not the shrink-padded one (#505) (60a664b)

## [5.30.0] - 2026-07-11

### Added
- seed the REPL from a launch argument (`afk "prompt"` / `afk /review`) (#510) (ae561dd)

## [5.29.3] - 2026-07-11

### Fixed
- decouple bash/grep output kill-cap from model budget; keep head+tail (#507) (dda24b2)

## [5.29.2] - 2026-07-11

### Fixed
- keep the update-notifier fresh instead of ≤24h stale (#504) (f9225b5)

### Changed
- Merge branch 'main' of https://github.com/griffinwork40/agent-afk (589d1b0)
- removed stale ref to legacy import (7f147e9)
- split terminal-compositor.test.ts monolith into topic siblings (#369) (#498) (1f89e9e)

## [5.29.1] - 2026-07-11

### Fixed
- mirror exit_plan_mode's deferred flip onto stats.permissionMode (#495) (#497) (2710e6b)

## [5.29.0] - 2026-07-11

### Added
- classify usage-limit 429s via anthropic-ratelimit-unified-* headers (#488) (#490) (a43dab4)

## [5.28.3] - 2026-07-11

### Changed
- extract dispatch-batching + repeat-circuit-breaker from dispatcher.ts (#361) (#496) (045f1de)

## [5.28.2] - 2026-07-11

### Fixed
- surface deps-not-installed note on create (#479) (21375e9)

## [5.28.1] - 2026-07-11

### Fixed
- cap session-grants.jsonl growth with atomic size trim (#473) (5a7d3db)

## [5.28.0] - 2026-07-11

### Added
- observe-only safe-destruct PreToolUse detector (gate-migration wave 1) (#492) (a442571)

## [5.27.2] - 2026-07-11

### Changed
- split config.ts into tier modules (#368) — checkpoint (#493) (db9e42c)

## [5.27.1] - 2026-07-10

### Changed
- consolidate 3 grant-manager copies into shared module (#361, #362 prep) (#489) (e2b745c)
- split skill-executor.ts into per-strategy modules (#363) (#491) (2a24d2f)

## [5.27.0] - 2026-07-10

### Added
- first-class isolation:"worktree" for the agent tool (#487) (7941226)

## [5.26.5] - 2026-07-10

### Fixed
- route long/absent-retry-after 429s back to the usage-limit pause path (#483) (34a09c5)

## [5.26.4] - 2026-07-10

### Changed
- split elicitation-repl.ts into mode modules (#367) (#484) (c3e39d6)

## [5.26.3] - 2026-07-10

### Changed
- split plugin-skills.ts into flags/listing/reload modules (#366) (#486) (cd37ef1)
- split loop.test.ts into sibling suites (#370) (#485) (708c4ff)

## [5.26.2] - 2026-07-10

### Added
- ask-question PreToolUse gate + orphan root-settings warning (#477) (362d05b)

### Changed
- retire vendored TS orchestrator for bundled SKILL.md (#480) (88a77db)
- mark AFK_MAX_TOKENS / maxTokens as deprecated and inert (#482) (f37b0a9)

## [5.26.1] - 2026-07-10

### Changed
- cover in-turn SubagentStop injectContext append (#391) (#481) (73e8644)
- extract appendInjectContext helper (#393) (#478) (b0cbbed)

## [5.26.0] - 2026-07-10

### Added
- GPT-5.6 model family support for the openai-compatible provider (reachable via
  Codex ChatGPT-OAuth or an OpenAI API key): explicit 1M context-window entries
  (`MODEL_CONTEXT_LIMITS`) and 128k max-output-token entries
  (`MODEL_MAX_OUTPUT_TOKENS`) for the `gpt-5.6` alias and the
  `gpt-5.6-sol`/`-terra`/`-luna` variants (plus `gpt-5.5`, previously falling
  through to the 262k / 64k defaults), `/model` picker listings, and an updated
  ChatGPT/Codex-backend 400 diagnostic. Without the output-cap entries these ids
  hit `DEFAULT_MAX_OUTPUT` (64k) and silently halved their advertised 128k output
  budget when `config.maxOutputTokens` was unset, truncating long code/research
  responses. Routing and the reasoning/vision request contract already covered
  `gpt-5.6` via the `/^gpt-5/` patterns; this closes the maintained-table gaps
  and adds regression coverage.

### Added
- add GPT-5.6 family support to openai-compatible provider (#474) (068d910)

## [5.25.11] - 2026-07-10

### Fixed
- Telegram: don't guillotine long agent turns at 90s — disable Telegraf's default `handlerTimeout` so the purpose-built `streaming.ts` inactivity watchdog is the sole timeout authority; fixes the spurious "❌ An unexpected error occurred. Please try again." shown while a turn (sub-agents, web_scrape, long tool calls) was still running and would complete

### Fixed
- make witness traces correlatable to sessions via ledger meta (#476) (4a7833f)
- disable Telegraf 90s handlerTimeout so long turns aren't guillotined (#475) (1e80771)

## [5.25.10] - 2026-07-09

### Fixed
- space out ⚡ glyph and bp tag in bypass prompt caret (#472) (32ea78d)

## [5.25.9] - 2026-07-09

### Fixed
- #441 robustness cluster — grep cwd-error enrichment, subagent cache invalidation, worktree-root debug log (#471) (fe19cb5)

## [5.25.8] - 2026-07-08

### Changed
- generalize o-series predicate to reasoning-model contract (#463) (fad5e64)

## [5.25.7] - 2026-07-08

### Fixed
- surface capped/truncated partials to the parent instead of silent success (#461) (9cfddd0)

### Changed
- negative coverage for flag-like/path-traversal base refs (#398) (#458) (badf06f)

## [5.25.6] - 2026-07-08

### Fixed
- Witness-trace `origin` attribution for forked subagents: `agent`-tool and `compose` child (and grandchild) sessions were made trace-visible in #466 but recorded `origin: "unknown"` instead of the owning surface, because the session `surface` was never threaded into the fork managers (only `traceWriter`/`cwd` were). The REPL/chat/Telegram/daemon root managers, the nested depth-2+ child manager, and the compose executor's manager now carry the surface, so forked children inherit the correct `origin` (`cli`/`telegram`/`daemon`) via `forkSubagent`'s `parentSurface` fill — mirroring the existing `farm.ts` pattern. Follow-up to Codex review on #466. (Skill-forked subagents share the same latent gap and are tracked separately.)

### Fixed
- thread session surface into fork managers so forked subagents get correct trace origin (#468) (b86fdb5)

## [5.25.5] - 2026-07-08

### Fixed
- fix wrap overflow + bound and label the diagnose verifier fan-out (#470) (227a99e)

## [5.25.4] - 2026-07-08

### Fixed
- Messages typed during the ESC soft-stop settle window now **merge** into one next turn instead of last-wins replacement. The #403 coalescing kept only the latest post-ESC message, so a real instruction followed by a "." liveness poke silently dropped the instruction — the "it didn't send" report, round 2. All post-ESC messages now join (newline-separated, attachments concatenated) and run as exactly one next turn; the no-backlog invariant and the pre-ESC queue-preservation contract are unchanged.

### Fixed
- merge post-ESC type-ahead instead of last-wins so soft-stop never drops a typed message (#467) (064ea20)

## [5.25.3] - 2026-07-07

### Fixed
- tolerate indented fences in isInOpenCodeFence parity check (#464) (ec31016)

## [5.25.2] - 2026-07-07

### Fixed
- `agent`-tool and `compose` subagents are now visible in the witness trace (`afk trace show`). Three gaps closed: (1) `forkSubagent` resolves the trace writer as per-fork config → manager-level writer, so the `subagent_lifecycle` started/succeeded/failed/cancelled events and the handle's writer no longer silently drop when inheritance came from the manager; (2) the REPL/chat/Telegram root managers and compose executors now carry the session trace writer; (3) the writer chains through nested child managers (depth ≥ 2 `agent` forks), mirroring the existing `cwd` chain. Previously a raw `agent` dispatch produced zero trace events between `tool_call started` and `completed` — a stuck child was indistinguishable from a never-started one.

### Fixed
- make agent-tool and compose forks visible in the witness trace (#466)do (a41a7d3)

## [5.25.1] - 2026-07-07

### Fixed
- Forked subagents no longer hang their parent indefinitely: every fork now gets a bounded wall-clock budget by default — 20 min foreground (`SUBAGENT_DEFAULT_TIMEOUT_MS`), 60 min background (`SUBAGENT_BACKGROUND_TIMEOUT_MS`) — instead of the unbounded session default. On expiry the child's controller aborts (cascading to descendants) and the parent receives a legible timeout error. Explicit `timeoutMs` wins; `0` restores unbounded.
- Forked subagents now **fail fast on OAuth usage-limit pauses** (`autoResumeOnUsageLimit` defaults to `false` for forks) instead of silently polling for reset — up to 2 h — while the parent looked frozen. The classified usage-limit error surfaces to the parent, which decides whether to retry, reroute, or surface the pause. Callers may opt a child back in with an explicit `autoResumeOnUsageLimit: true`.

### Fixed
- bound fork wall-clock budget + fail fast on usage-limit pauses (#465) (1516e65)
- preserve empty-fence <i> label when the safety net strips emphasis (#456) (64ddd04)
- thread openaiBaseUrl so OpenAI Telegram sessions reach the configured endpoint (#459) (e674621)

### Changed
- consolidate o-series detection into one predicate (#457) (db71f16)

## [5.25.0] - 2026-07-07

### Added
- New opt-in `AFK_MAX_TOOL_USE_ITERATIONS` env var sets a **top-level** tool-use-round ceiling for both providers (mirrors the `maxToolUseIterations` config key / `max_tool_use_iterations` tool param). Unset/`<=0` = unlimited (the default — zero behavior change); a positive integer N winds top-level turns down gracefully after N rounds. An explicit config value wins over the env default. Subagent forks are unaffected — they keep their own 50-round anti-hang default regardless of the var. Restores an operator brake for runaway top-level tool loops without reintroducing a default cap or provider drift.

### Changed
- The tool-round cap (`max_tool_use_iterations`) and its graceful wind-down now apply uniformly to **both** providers. openai-compatible previously ignored the setting and hard-capped every turn at 50 rounds; it now honors `maxToolUseIterations` like anthropic-direct. Consequence: **top-level openai-compatible sessions are now uncapped by default** (aligned with anthropic-direct) — the 50-round anti-hang default still applies to subagent forks of either provider. The shared cap/wind-down policy (constants + `resolveMaxToolIterations`/`shouldWindDown`) now lives in `providers/shared/tool-loop-cap.ts`, so the two providers can no longer drift.

### Fixed
- openai-compatible now runs the same tools-stripped "wind-down" round as anthropic-direct when the tool-round cap fires (previously it fell through to a possibly-empty final message with no cap signal), and stamps `tool_use_loop_capped` so the closure classifier reports `iteration_cap` for openai-compatible turns too.

### Added
- extend tool-loop cap + graceful wind-down to openai-compatible (follow-up to #448) (#454) (b0e85c7)

### Fixed
- align getApiKey() default-model resolution with getModel() (#455) (667951e)

### Changed
- Add AFK Dark theme for Terax (#460) (c9bb8f4)
- calm REPL chrome (glyph mode marker, idle rail, cwd/branch dedupe) (#447) (d1bd410)
- extract runIteration concerns into query/ modules (#453) (a04e781)
- extract query() concerns into query/ modules (#452) (1c16f81)
- dedupe elicitation validators into field-validation module (#451) (a7f2457)

## [5.24.0] - 2026-07-06

### Changed
- `agent` tool subagents are now uncapped by default and settable per dispatch: `max_turns` defaults to unlimited (was default 10, hard-clamped to `[1,50]`) — pass a positive integer to cap. Added a `max_tool_use_iterations` param and a matching `maxToolUseIterations` agent-frontmatter field (both default unlimited on the agent-tool path). Skill/compose internal forks keep the 50-round anti-hang default; openai-compatible models retain a provider-internal 50-round cap regardless.

### Fixed
- Hitting the tool-use iteration cap no longer ends a turn silently (which read as a hang / empty subagent result). The anthropic-direct loop now runs one final tools-stripped "wind-down" round so the model synthesizes a real answer from what it gathered, and the closure classifier maps the capped stop reason to `iteration_cap` instead of silently sealing it as a clean `model_end_turn`.

### Added
- uncap turn/tool-use budgets by default; graceful wind-down on cap (#448) (1ba29e7)
- persist thinking-ui default via AFK_THINKING_UI + interactive.thinkingUi (#445) (7a1f403)

### Fixed
- audit grant only on state change to stop session-grants.jsonl bloat (#449) (ed95705)
- warn for stale-clean worktrees (#450) (3223077)
- delete swept branches + stop reaping live-session worktrees (#371, #380) (77f6e72)
- resolve subagent credential per child model, not ambient (#378) (#431) (7e6b90c)
- stop glob from descending node_modules/.git; add multi-** tests (#436) (#442) (97a6b40)
- stop shadow-verify nudge self-triggering on verifier verdict output (#355) (#433) (7d81612)
- reject flag-like worktree base refs (#428) (fcfc830)
- warn for stale-clean worktrees (#430) (0c61247)
- require commits ahead for stale-clean worktrees (#429) (1987415)

### Changed
- fix stale budget-contract expectations + tool/memory schema mocks (cbb4c32)
- add direct unit tests for extracted subagent/ modules (#446) (947739f)
- extract execute() into subagent/ modules (#443) (070ded6)

## [5.23.2] - 2026-07-05

### Fixed
- patient 429 retry-after handling + surface stopReason on SubagentResult (#427) (d535c79)

## [5.23.1] - 2026-07-05

### Fixed
- scope the bash interpreter-eval guard to credential-adjacent payloads (#424) (8eb2622)

## [5.23.0] - 2026-07-05

### Added
- add `digest` thinking-display mode (live preview + persisted reasoning) (#426) (6740847)

## [5.22.0] - 2026-07-05

### Added
- plugin-contributed agent scope + scoped nested dispatch (#423) (249c27c)

## [5.21.1] - 2026-07-05

### Fixed
- resolve project plugins against session cwd (#179 follow-up) (#418) (7317aa4)

### Changed
- remove /reset slash command; fix stale /clear docs (#425) (ea1950c)

## [5.21.0] - 2026-07-05

### Added
- accept per-slot model binding objects in config_set (#409) (6c6c81f)

### Changed
- bump @types/node from 22.19.19 to 26.1.0 in /website (#422) (0f5d4e8)
- bump next from 16.2.9 to 16.2.10 in /website (#421) (438ca42)
- bump @types/react from 19.2.16 to 19.2.17 in /website (#420) (20e0bd7)
- bump the fumadocs group in /website with 2 updates (#419) (fcd018d)

## [5.20.8] - 2026-07-05

### Fixed
- grant main-repo read root to worktree subagents (#416) (205612e)
- resolve project skills against the session cwd (#179) (#375) (4919343)

## [5.20.7] - 2026-07-05

### Fixed
- make exit_plan_mode live-mode-gated + restore working mode across the Shift+Tab ring (#410) (99468d8)

## [5.20.6] - 2026-07-05

### Added
- add /thinking slash command for mid-session thinking-UI toggle (#415) (49eb8c8)

### Fixed
- thread openaiBaseUrl into restricted provider builders so deep OpenAI subagents keep their endpoint (#413) (26cd2e1)
- gate exit backstop on persisted seal record, not optimistic sealed flag (#171) (#402) (d6dbb5f)

### Changed
- collapse duplicated dispatch + skill-fork logic (#408) (2159df2)
- changed several bundled skills to load mode (dfdb8d5)
- Bump version from 1.0.0 to 1.0.1 (e8d57ee)
- Change context from 'fork' to 'load' in SKILL.md (5d0a595)

## [5.20.5] - 2026-07-05

### Fixed
- surface silent 429/503/529 backoff in trace; fix transient rate-limit 429 misclassification (#414) (5dbc55b)

## [5.20.4] - 2026-07-05

### Fixed
- coalesce post-ESC type-ahead so soft-stop doesn't strand input one turn behind (#403) (937772e)

### Changed
- isolate vitest state writes from real ~/.afk (#411) (9f6b634)
- bound default-sonnet cost via auto-compaction budget (keep truthful 1M); split openai-compatible/query.ts (#407) (37a878d)

## [5.20.3] - 2026-07-04

### Fixed
- stop double-rendering finished subagents in the REPL overlay (#405) (71a6bdc)

## [5.20.2] - 2026-07-04

### Fixed
- make SKILL.md context: authoritative; drop DEFAULT_FORK_SKILLS (#404) (023cf51)

## [5.20.1] - 2026-07-04

### Fixed
- report a clean git tree as dirty:false, not null (#389) (78c4083)

## [5.20.0] - 2026-07-04

### Added
- named agent definitions with agent_type dispatch on the agent tool (#384) (c9f6040)

## [5.19.5] - 2026-07-04

### Fixed
- name dead-cwd spawn failures and fork-enforce bundled skills by name (#399) (1ee5d81)

### Changed
- update AFK.md with new commands and architecture details (d31cfc6)

## [5.19.4] - 2026-07-04

### Fixed
- reflow committed band at paint-time width; fail-safe commits on stale resize geometry (#386) (f75d8a4)

## [5.19.3] - 2026-07-03

### Fixed
- expand ${PLUGIN_ROOT:-fallback} idiom in load-mode substitution (#401) (a13ff98)

## [5.19.2] - 2026-07-03

### Fixed
- bound forked-child tool-use loop to prevent parent hang (#394) (a645cab)
- bound subagent fan-out in compose/DAG layers and runWave (#385) (52f8a7c)
- fire SubagentStop for naturally-completing background subagents (#388) (d9832e7)

## [5.19.1] - 2026-07-03

### Fixed
- cancel in-flight foreground subagents on soft-stop (ESC/Ctrl-C) (#400) (1e838d1)

## [5.19.0] - 2026-07-03

### Added
- lifecycle tool + sweep fix for agent-managed worktrees (#390) (eaa561d)

## [5.18.0] - 2026-07-03

### Added
- deliver SubagentStop injectContext in-turn via the subagent tool_result (#387) (a407d35)

## [5.17.0] - 2026-07-03

### Added
- grounded progress banner — real activity instead of mechanism noise (#373) (f475744)

## [5.16.0] - 2026-07-03

### Added
- collapse sequential same-tool runs into one grouped ×N row (#379) (ac9c609)

### Changed
- remove verified dead code across src/ (Tier 1 audit batch) (#382) (d7c4056)

## [5.15.13] - 2026-07-03

### Fixed
- deliver SubagentStop injectContext with the next user message, not as its own turn (#359) (c2d5078)

## [5.15.12] - 2026-07-03

### Added
- auto-deliver background subagent results into the next turn (#372) (0c92c7c)

### Fixed
- close AFK-mode coverage gaps + clip afk-push rawBody fallback (#200) (#357) (ad5e64a)

## [5.15.11] - 2026-07-03

### Fixed
- close reverse-direction forkSubagent credential leak (#377) (a30cd61)

## [5.15.10] - 2026-07-02

### Fixed
- bound foreground safe-batch tool concurrency (#376) (cb9fe2a)

## [5.15.9] - 2026-07-02

### Fixed
- approve better-sqlite3 native build script for pnpm 10 (#383) (001b864)

## [5.15.8] - 2026-07-02

### Fixed
- thread defaultSubagentModel through nested skill executors (#381) (35e922b)

## [5.15.7] - 2026-07-02

### Fixed
- evict project-origin skills when cwd changes (#179) (#356) (89c358b)

## [5.15.6] - 2026-07-02

### Fixed
- close forkSubagent cross-provider credential leak (#374) (9294525)

### Changed
- add docs/mcp.md — MCP config, transports, OAuth, security (#180) (#358) (566513d)

## [5.15.5] - 2026-07-01

### Fixed
- keep the typing indicator alive for the whole turn (#352) (819ad6c)
- correct stale commit geometry (#351) (002bcd1)
- normalize canUseTool gates to AFK runtime tool names (#350) (0d1fca6)

## [5.15.4] - 2026-07-01

### Fixed
- close abort TOCTOU so an in-flight child is killed, not orphaned (#349) (ca2d948)

## [5.15.3] - 2026-07-01

### Fixed
- suspend stream watchdog while a foreground tool is in flight (#348) (f06fc78)

## [5.15.2] - 2026-07-01

### Fixed
- concatenate injectContext across non-blocking handlers instead of last-wins (#345) (fffb8e1)

## [5.15.1] - 2026-07-01

### Fixed
- close 2-segment MCP verb-gate bypass from PR #339 review (#347) (c3133ed)

## [5.15.0] - 2026-07-01

### Added
- swap default sonnet alias to claude-sonnet-5 (#346) (da492d4)

### Fixed
- classify MCP/browser/schedule/web tools so AFK gate covers them (#198) (#339) (245aee2)

## [5.14.1] - 2026-07-01

### Fixed
- dedup repeated quarantine log noise for poison entries (#252) (#341) (28e01e5)

### Changed
- drop dormant forge/briefs plugin couplings from core (#344) (695c49d)
- isolate vitest suite from ambient AFK_* config env (#343) (467da83)

## [5.14.0] - 2026-06-30

### Added
- emit mcp_connect_* trace phases on daemon surface (#248) (#338) (438b466)

## [5.13.1] - 2026-06-30

### Fixed
- suspend input + pause stdin before /transcript pager (#342) (28db0e0)

### Changed
- real-world examples and a Bundled Skills reference page (#340) (bb3a93b)

## [5.13.0] - 2026-06-29

### Added
- inject session-facet substrate into PluginApi (11→15) (#337) (07fbec6)

## [5.12.0] - 2026-06-29

### Added
- inject runtime values into PluginApi for code-backed plugins (#335) (337f118)

## [5.11.0] - 2026-06-29

### Added
- agent browser autonomy MVP (session vault, park-and-notify, retrying fetch) (#323) (ff676af)

## [5.10.3] - 2026-06-29

### Fixed
- always allow exit_plan_mode on top-level surfaces (REPL/chat/Telegram) (#334) (14867a3)
- make agentType required on ForkSubagentOptions; add to all callsites (#330) (f281e79)

## [5.10.2] - 2026-06-29

### Fixed
- refill the viewport after end-of-turn collapse of an over-tall block (#332) (a0cbf3c)

## [5.10.1] - 2026-06-29

### Added
- inject host runtime API into plugin entrypoints (fixes singleton trap) (#324) (4cd187b)

### Fixed
- wire grant manager for OpenAI-compatible providers in REPL bootstrap (#316) (1648120)

### Changed
- extract shared helpers into providers/shared (#329) (4d557aa)

## [5.10.0] - 2026-06-29

### Added
- trace skill-forked subagent tool denials + receipt refusal tally (#333) (6cbcee6)

## [5.9.1] - 2026-06-29

### Fixed
- stop JSON.parse error snippets leaking secrets in poison logs (#318) (0290797)

## [5.9.0] - 2026-06-29

### Added
- emit PreCompact hook on auto-compaction (#328) (eba1ef9)

### Changed
- bring Fumadocs site up to date with code (#331) (729e986)

## [5.8.1] - 2026-06-29

### Fixed
- honor trailing-backslash newline escape on the live TTY path (#325) (9ffc326)
- never emit improperly-nested HTML from interleaved emphasis (#321) (b0c1233)
- wrap schema migrations in transactions to close torn-state window (#319) (74b5c41)

## [5.8.0] - 2026-06-29

### Added
- add list/remove/clear subcommands + document improve & farm in README (#327) (cfea104)

### Changed
- add dependency-vulnerability audit gate (#326) (6a1f1d7)

## [5.7.1] - 2026-06-28

### Fixed
- interrupt provider turn on ANY incomplete stream exit (#320) (cd45b61)

## [5.7.0] - 2026-06-28

### Added
- wire canUseTool into the dispatcher — Agent SDK parity Dim 8 (increment 1) (#304) (f0ee88b)

## [5.6.1] - 2026-06-28

### Fixed
- restart launchd services + notify on stale manual bot after install (#322) (c40729a)

## [5.6.0] - 2026-06-28

### Added
- restore pre-plan permission mode on exit (#306) (1cbf61b)

### Changed
- bump typescript from 5.9.3 to 6.0.3 in /website (#315) (758303b)
- migrate docs site to Next.js 16 + React 19 + fumadocs 16 (#317) (56dc929)

## [5.5.1] - 2026-06-28

### Fixed
- don't silently exit plan mode on /afk off (#311) (55864c8)

## [5.5.0] - 2026-06-28

### Added
- load plugin entrypoints on chat/daemon/telegram surfaces (B4) (#308) (004ec25)
- add optional baseDir to loadSkillPrompts for out-of-tree plugins (#307) (77a07d3)

## [5.4.0] - 2026-06-28

### Added
- export framework skill/facet API for out-of-tree plugins (#305) (8905788)

## [5.3.2] - 2026-06-28

### Fixed
- redact filename in pull-queue quarantine log lines (#310) (213d20f)

### Changed
- cover pull-queue poison fallback + collision-retry branches (#313) (4e57cdc)
- backfill 4 uncovered scraper/render branches (#312) (fb6c480)
- add Dependabot coverage for website/ npm deps (#309) (f52a161)

## [5.3.1] - 2026-06-28

### Fixed
- surface most-recent tool-groups instead of burying them in overflow (#303) (93bb246)

## [5.3.0] - 2026-06-28

### Added
- high-risk AFK gate routes approve/deny to the phone (Phase 2 v1.5) (#294) (9e94126)

### Changed
- silent-model-loop debuggability issue + recommendations (#302) (b458191)

## [5.2.0] - 2026-06-28

### Added
- Agent SDK parity — query() entry, in-process tool(), main-turn structured output (#300) (1a1025c)

### Fixed
- width-cap the markdown message-fallback render path (#301) (92093f5)

## [5.1.0] - 2026-06-28

### Added
- plugin JS `main` entrypoint run at session boot (#298) (c956398)

### Fixed
- don't default the daemon task to an unavailable skill (#299) (7bf2742)

## [5.0.0] - 2026-06-28

### Added
- retire /bypass, add default badge, steer exit to exit_plan_mode (#286) (a38a566)

## [4.46.0] - 2026-06-28

### Added
- model-callable exit_plan_mode tool with elicitation picker (#285) (a961ae7)

## [4.45.5] - 2026-06-27

### Fixed
- stop the second streamed table from rendering broken (missing header/lines) (#296) (9cb4880)

## [4.45.4] - 2026-06-27

### Fixed
- re-point backend on a same-family /model switch to a different endpoint (#297) (38975c1)

## [4.45.3] - 2026-06-27

### Added
- add PreCompact hook event (#283) (aa25b10)

### Fixed
- subset advertised tool schema to permission allowlist (#295) (331ae7b)

## [4.45.2] - 2026-06-27

### Fixed
- don't send Chat-Completions max_tokens on the Responses path (#293) (f6ed619)

## [4.45.1] - 2026-06-27

### Fixed
- don't fire path-approval prompts in AFK mode (#292) (97dda5e)

## [4.45.0] - 2026-06-26

### Added
- `afk trace show` now surfaces the raw provider `stop_reason` (`stop=…`) on the closure line — it was already persisted on the closure event but unrendered, so silent stops (a turn that ends with no output and no error, e.g. a content-safety `refusal`) were only diagnosable by reading the raw `trace.jsonl`

### Added
- add PostToolUseFailure hook event (#282) (2a750fd)
- surface raw provider stop_reason in `afk trace show` (#291) (dfa28c5)

## [4.44.3] - 2026-06-26

### Fixed
- surface model content-safety refusals (stop_reason "refusal") instead of ending the turn silently — fixes the "it stopped and I can't send anything else" hang when the model declines a request

### Fixed
- surface model refusals instead of ending silently (ab84a62)

### Changed
- Merge pull request #290 from griffinwork40/fix/surface-model-refusal-stop-reason (21710d6)

## [4.44.2] - 2026-06-26

### Fixed
- preserve redacted_thinking blocks to prevent session wedge (40984ad)

### Changed
- Merge pull request #288 from griffinwork40/fix/preserve-redacted-thinking-blocks (fb79fc8)

## [4.44.1] - 2026-06-26

### Fixed
- stop mid-turn cutoffs, false rate-limit errors, and tool-call spam (be939f5)

### Changed
- Merge pull request #287 from griffinwork40/afk/fix-telegram-message-cutoff (5b66999)

## [4.44.0] - 2026-06-25

### Added
- add Stop as a harness hook event (ea5ba85)

### Fixed
- sanitize Stop hook reason and bound its dispatch timeout (ea7b5eb)
- address Stop review findings (b0c0ab6)

### Changed
- Merge pull request #281 from griffinwork40/feat/stop-hook (d6659b8)
- Merge origin/main into feat/stop-hook: resolve hook-event conflicts (keep UserPromptSubmit + Stop) (18c9864)

## [4.43.0] - 2026-06-25

### Added
- add automate skill to awa-bundled plugin (fa80af0)

### Changed
- Merge pull request #284 from griffinwork40/afk/refactor-automate-skill-source (e6c0d3f)

## [4.42.0] - 2026-06-25

### Added
- add UserPromptSubmit as 7th harness hook event (7b4e3b6)

### Fixed
- fail closed on UserPromptSubmit handler timeout in REPL loop (8bb8a8d)

### Changed
- Merge pull request #280 from griffinwork40/feat/user-prompt-submit-hook (6c30a87)
- Update README.md by removing 'afk login' command (f552ca9)

## [4.41.0] - 2026-06-24

### Added
- searchable conversation transcripts (FTS5) (e37e39b)

### Fixed
- harden index DB perms; surface skipped files (a03bccb)
- resolve PR #277 review findings (edabf6b)

### Changed
- Merge pull request #277 from griffinwork40/feat/transcript-search (3127bfa)

## [4.40.1] - 2026-06-24

### Fixed
- bottom-pin the input frame on a fresh session (54e25f5)

### Changed
- Merge pull request #279 from griffinwork40/fix/input-bottom-pin-fresh-session (900b8a0)
- Merge branch 'main' into fix/input-bottom-pin-fresh-session (5cf0ea9)
- Merge pull request #278 from griffinwork40/afk/standardize-bypass-casing (03c3dfd)
- Merge pull request #272 from griffinwork40/chore/launch-readiness-polish (951aaf5)
- lowercase bypass chip + drop redundant model from REPL caret (57c4580)
- Merge branch 'main' into chore/launch-readiness-polish (666e3d2)
- launch-readiness polish for README + npm discoverability (e93d7d0)

## [4.40.0] - 2026-06-24

### Added
- blinking input caret (pulse on/off like a terminal cursor) (3096ee9)

### Changed
- Merge pull request #271 from griffinwork40/afk/improve-caret-styling (32d99d6)
- coalesce off-phase caret-blink reset with the keystroke repaint (16404db)
- thin ▏ caret + cornflower-blue palette.caret accent (74e25b7)

## [4.39.2] - 2026-06-24

### Fixed
- fill width budget in degenerate table squeeze (12cc790)

### Changed
- Merge pull request #270 from griffinwork40/fix/table-degenerate-growback (8734e4e)
- make growOrder sort deterministic on equal-width tie-break (ef3cd9d)

## [4.39.1] - 2026-06-24

### Fixed
- protect narrow table columns from ellipsis truncation (8c65fa3)

### Changed
- Merge pull request #269 from griffinwork40/fix/table-narrow-column-squeeze (65ce572)

## [4.39.0] - 2026-06-24

### Added
- surface current date in system-prompt environment block (3f600b0)

### Changed
- Merge pull request #268 from griffinwork40/afk/agent-date-awareness (6204544)

## [4.38.1] - 2026-06-24

### Fixed
- re-split rendered HTML in pushMarkdown to avoid 4096 truncation (e9f1014)
- render markdown in daemon task notifications (0f007b4)

### Changed
- Merge pull request #267 from griffinwork40/fix/telegram-daemon-markdown-render (35fcce9)

## [4.38.0] - 2026-06-24

### Added
- show git branch + open PR on the REPL status line (da9c4fd)

### Fixed
- resolve three medium review findings (f5fd3c5)

### Changed
- Merge pull request #265 from griffinwork40/afk/git-branch-pr-status (5813da2)

## [4.37.1] - 2026-06-24

### Fixed
- propagate origin/actor through grandchild-skill, compose, and daemon-fallback routing rows (fe1bdce)

### Changed
- Merge pull request #261 from griffinwork40/fix/routing-identity-completeness (9a4c3db)
- Merge branch 'main' into fix/routing-identity-completeness (584ed06)

## [4.37.0] - 2026-06-24

### Added
- emit browser_event from browser tool handlers (897a02f)

### Changed
- Merge pull request #262 from griffinwork40/feat/browser-event-emission (df1e42f)

## [4.36.0] - 2026-06-24

### Added
- classification eval for tool-failure-density contract (f714332)

### Changed
- Merge pull request #266 from griffinwork40/feat/improve-eval-run-tool-failure-classification (ee55b8b)

## [4.35.0] - 2026-06-23

### Added
- fixture-replay eval-run for closure-anomaly (b16f563)
- emit tool_call + session_phase events from openai-compatible provider (819e688)

### Fixed
- inherit traceWriter + surface into farm worker sessions (38f730f)
- wire traceWriter + surface into farm sessions (bffe26b)
- pass traceWriter to MCP manager in telegram sessions (ea74f7d)

### Changed
- Merge pull request #260 from griffinwork40/fix/telegram-mcp-trace-writer (8862c63)
- Merge pull request #259 from griffinwork40/fix/farm-trace-wiring (7709ae3)
- Merge pull request #258 from griffinwork40/feat/openai-trace-events (61ae0cf)
- Merge pull request #264 from griffinwork40/feat/improve-eval-run-closure-replay (02dc1b4)

## [4.34.0] - 2026-06-23

### Added
- fixture-replay eval-run proves recorded failure fixed (cbcf73f)

### Changed
- Merge pull request #263 from griffinwork40/feat/improve-eval-run-fixture-replay (7bc4edf)

## [4.33.2] - 2026-06-23

### Fixed
- accept absent hook_decision.decision key (zod 4.4 regression) (ac246d7)

### Changed
- Merge pull request #256 from griffinwork40/fix/hook-decision-schema-zod44 (6d39441)

## [4.33.1] - 2026-06-23

### Fixed
- use exact painted-row count for the band-hold pending signal (196f818)
- commit flushed blocks atomically so band-hold doesn't gap scrollback (10e25ed)

### Changed
- Merge pull request #257 from griffinwork40/fix/tui-overflow-pending-exact-count (ee8ebd4)
- Merge pull request #255 from griffinwork40/fix/tui-band-hold-pending-gap (8965b3b)

## [4.33.0] - 2026-06-23

### Added
- wire passive SIGNAL-block parsing into buildResultFromMessage (18be452)

### Changed
- Merge pull request #254 from griffinwork40/feat/wire-signal-block (3610ea4)

## [4.32.0] - 2026-06-23

### Added
- add Ctrl+L, Ctrl+D, and line-relative Home/End (c2d4f36)

### Changed
- Merge pull request #231 from griffinwork40/feat/tui-repl-keybindings (b528fc0)
- add dispatch-level coverage for Ctrl+L/Ctrl+D/Home/End keys (7463f7d)

## [4.31.2] - 2026-06-23

### Fixed
- redact poison-quarantine logs and harden listPending (bd272f8)
- quarantine malformed pull-queue entries instead of silent deadlock (c1d543f)

### Changed
- Merge pull request #241 from sorcerai/fix/daemon-pull-queue-poison-deadlock (6d6e360)
- Delete .claude/scheduled_tasks.lock (52fba48)
- Delete .afk/plans/shift-tab-permission-mode-cycle.md (50f68da)
- Delete .afk/plans/normalize-session-identity-telemetry.md (7550c43)
- Delete .afk/plans/default-permission-mode-bypass.md (387afb3)
- Update .gitignore to exclude local plans dir (01ccea6)

## [4.31.1] - 2026-06-22

### Fixed
- brief-queue gate counts only top-level .md files (eeb9cef)

### Changed
- Merge pull request #246 from griffinwork40/fix/daemon-brief-gate-ignore-subdirs (ac17a87)

## [4.31.0] - 2026-06-22

### Added
- wire MCP servers into chat, daemon, and telegram surfaces (96b9fae)

### Fixed
- daemon imported-config parity + close MemoryStore on connect failure (#244) (77e92fe)

### Changed
- Merge pull request #244 from sorcerai/fix/mcp-surface-parity (f16aa4b)

## [4.30.0] - 2026-06-22

### Added
- tag dispatched gate skills with is_gate (port afk-workshop#823) (57c38d3)

### Fixed
- scope is_gate to skill.dispatched on the load path (port afk-workshop#823) (8b08141)

### Changed
- Merge pull request #243 from griffinwork40/afk-port/pr-823 (ba9acda)
- Merge pull request #245 from griffinwork40/afk-port/pr-824 (e388965)
- deprecate redundant skill-invocations.jsonl writer (port afk-workshop#824) (e3c563f)

## [4.29.1] - 2026-06-22

### Fixed
- keep session alive after mid-turn interrupt (ESC) (073004c)

### Changed
- Merge pull request #242 from griffinwork40/fix/interrupt-mid-turn-resume (095e318)

## [4.29.0] - 2026-06-21

### Added
- opt-in "Done" verification for AFK Telegram pushes (#237) (9efb1c1)

### Changed
- Merge pull request #238 from griffinwork40/feat/telegram-verify-done (ef8d204)
- resolve PR #238 review feedback (5fd2d60)

## [4.28.0] - 2026-06-21

### Added
- warn on supersede of uncited/stale-cited codebase facts (065c3ea)
- evidence-gate durable memory writes behind AFK_MEMORY_EVIDENCE_GATE (a942ef4)

### Changed
- Merge pull request #240 from griffinwork40/feat/memory-evidence-gate (250d38e)
- bump parallel tests/ schema assertion to v4 (4c9403b)

## [4.27.3] - 2026-06-21

### Fixed
- resolve PR #229 review — ordered task glyphs + honest render tests (0aaa671)
- render task-list checkboxes, width-aware rules, wide-char dropdown height (7c81a2a)

### Changed
- Merge pull request #229 from griffinwork40/fix/tui-markdown-rendering (502b8d4)
- Merge branch 'main' into fix/tui-markdown-rendering (5c64928)
- Merge pull request #236 from griffinwork40/fix/mailmap-lightjunction (1fd37c0)
- re-attribute @LIghtJUNction's PR #96 commit via .mailmap (43f93cf)

## [4.27.2] - 2026-06-21

### Fixed
- terminate query generator on interrupt during usage-limit wait (c462ebd)

### Changed
- Merge pull request #235 from griffinwork40/afk/fix-usage-limit-hang (77b7b3b)

## [4.27.1] - 2026-06-21

### Fixed
- re-anchor compose DAG nodes on cwd change (e3d57f3)

### Changed
- Merge pull request #228 from griffinwork40/fix/compose-cwd-reanchor (c46e4f3)

## [4.27.0] - 2026-06-21

### Added
- surface hidden REPL features in help, hints & banner (0688398)
- add read-only SessionEnd run receipt (611ad70)

### Changed
- Merge pull request #230 from griffinwork40/feat/tui-discoverability (f630689)
- Merge pull request #234 from griffinwork40/feat/session-end-run-receipt (6b21e8e)

## [4.26.1] - 2026-06-21

### Fixed
- timelier context-usage signal & overlay-safe overflow warning (6e759de)

### Changed
- Merge pull request #232 from griffinwork40/fix/tui-context-visibility (46038c4)
- Merge pull request #227 from griffinwork40/afk/claude-login-update (d478ae6)
- Merge pull request #233 from griffinwork40/chore/tui-remove-dead-repl (19fbe66)
- remove dead legacy readline REPL & unused jest devDeps (5e8edea)
- use `claude login` for the OAuth flow in quickstart (6661928)

## [4.26.0] - 2026-06-21

### Added
- add `cards list --regressed` observability view (de0b2d4)

### Changed
- Merge pull request #226 from griffinwork40/improve/cards-regressed-view (f0c3765)

## [4.25.0] - 2026-06-21

### Changed
- Shift+Tab now cycles permission modes (default → plan → bypass) instead of toggling plan mode on/off; AFK (autonomous) stays on `/afk` and, if active, Shift+Tab exits it cleanly to default

### Added
- Shift+Tab cycles permission modes (default → plan → bypass) (0b3e019)

### Changed
- Merge pull request #225 from griffinwork40/afk/20260620-194641-1e7273 (b98d443)
- strengthen Shift+Tab permission-cycle coverage (PR #225 review) (ef8fefc)

## [4.24.0] - 2026-06-20

### Added
- restyle bypass indicator as a "full-power" badge, not a caution (bef7ea1)

### Changed
- Merge pull request #224 from griffinwork40/afk/20260620-174826-3dd82c (3335c7d)

## [4.23.2] - 2026-06-20

### Fixed
- re-anchor executors in dispatcher.setResolveBase (openai-compatible parity) (d53b198)
- skip worktree-prune gracefully when daemon cwd is not a git repo (9e96e80)
- propagate setCwd to sub-agent/skill executors (re-anchor forks) (fec6a73)
- re-write presence cwd on setCwd so live worktrees aren't reaped (95c31d7)

### Changed
- Merge pull request #223 from griffinwork40/fix/worktree-cwd-presence-propagation (87b3147)

## [4.23.1] - 2026-06-20

### Fixed
- render non-empty fenced code blocks not preceded by a blank line (6de3a6e)

### Changed
- Merge pull request #222 from griffinwork40/afk/20260620-075608-f550fc (7aa3528)

## [4.23.0] - 2026-06-20

### Added
- default to bypass mode for new installs (024d808)

### Changed
- Merge pull request #220 from griffinwork40/afk/20260619-170734-66ec93 (fb41455)
- Merge pull request #221 from griffinwork40/afk/20260619-171015-92ea08 (eba6bfe)
- note the interpreter denylist is default-on and tunable (792d3af)
- sync docs website with v4.9-v4.22; add permissions page (0f76702)

## [4.22.0] - 2026-06-19

### Added
- edit queued type-ahead with ↑; stop dequeuing on Backspace (4268d7c)
- config key + --dangerously-skip-permissions flag for bypass (445c4b9)
- add /bypass REPL toggle + status-line BYPASS badge (dd3a893)
- make bypassPermissions disable path containment (core) (39f7a83)
- queue multiple type-ahead messages mid-turn (8daba12)

### Fixed
- make the live /bypass toggle actually change enforcement (a6de8c7)
- keep `queued` mirror in sync on paste + idle-submit paths (fcbf295)

### Changed
- Merge pull request #215 from griffinwork40/afk/20260618-180522-9c6c46 (2cb373b)
- Merge pull request #219 from griffinwork40/feat/bypass-grant-all (61e9add)
- Merge main into afk/20260618-180522-9c6c46 (resolve type-ahead queue conflict) (5d4d70a)
- correct stale bypass-by-default claims; document /bypass (bed6aa3)

## [4.21.1] - 2026-06-19

### Fixed
- make forked sub-agents non-interactive (96d7b3a)

### Changed
- Merge pull request #218 from griffinwork40/fix/subagents-non-interactive (3e4f8e8)

## [4.21.0] - 2026-06-19

### Added
- interactive usage-limit picker (C) (de2d3be)
- make usage-limit pause actionable at the keyboard (A+B) (4ecc2d2)

### Fixed
- guard runPicker promise with .catch() to avoid unhandled REPL rejection (3d92e53)

### Changed
- Merge pull request #217 from griffinwork40/afk/20260618-163800-fba9fe (80f4e95)

## [4.20.0] - 2026-06-19

### Added
- persist session origin/actor into state artifacts (Stage D) (d71a734)
- record origin + actor on routing + skill-invocation rows (Stage B+C) (696953f)
- record session origin + actor on witness trace (Stage A) (f5fa3a1)

### Fixed
- make v2→v3 actor-column migration concurrency-safe (8f1fed9)

### Changed
- Merge pull request #214 from griffinwork40/afk-20260618-123344-8c609e (7ff9ba5)
- Merge remote-tracking branch 'origin/main' into afk-20260618-123344-8c609e (de10091)
- mark Stage D done (session identity in state artifacts) (4c042c1)
- mark Stage B+C done (origin/actor on JSONL telemetry) (5e34188)
- session-identity normalization plan (Stage A done; B-D scoped) (abf3797)

## [4.19.1] - 2026-06-19

### Fixed
- tag provider surface as 'telegram' for presence/watch (2162ab5)

### Changed
- Merge pull request #216 from griffinwork40/fix/telegram-presence-surface (03629b6)
- Merge pull request #213 from griffinwork40/chore/mailmap-attribution (629ae9c)
- add .mailmap to re-attribute afk-port port commit (772cf55)

## [4.19.0] - 2026-06-18

### Added
- render MCP form enum/boolean fields as arrow-key selector (47546b9)

### Changed
- Merge pull request #212 from griffinwork40/afk/20260618-153242-30da7d (2cff1df)

## [4.18.3] - 2026-06-18

### Changed
- Merge pull request #208 from griffinwork40/refactor/extract-resolve-params (2acc9a0)
- extract pure param resolvers into resolve-params.ts (c5462c0)

## [4.18.2] - 2026-06-18

### Changed
- Merge pull request #211 from griffinwork40/simplify/terminal-compositor-dedup (6da7b60)
- centralize committed-band CUP+EL escape into eraseAndPaintRow (57f417e)

## [4.18.1] - 2026-06-18

### Changed
- Merge pull request #207 from griffinwork40/refactor/split-diagnose-into-phases (421e4b5)
- Merge pull request #210 from griffinwork40/refactor/split-tool-lane-overlay-test (0d9e6d0)
- extract overlay-rendering cluster into its own test file (58b90e2)
- split diagnose/index.ts into modules (e95ef57)

## [4.18.0] - 2026-06-18

### Added
- scope /resume session list to current working directory (3ba3674)

### Changed
- Merge pull request #209 from griffinwork40/afk/20260618-123959-6040de (e5c19af)

## [4.17.0] - 2026-06-18

### Added
- Path-access approval: typed file tools (`read_file`, `write_file`, `edit_file`, `list_directory`, `glob`, `grep`) targeting a path outside the session's granted roots now prompt for approval — once / session / persist / deny — via the REPL or Telegram elicitation surface. Persisted grants are stored in `~/.afk/config/permissions.json` and replayed on future sessions
- Bash restriction hook: hard-blocks interpreter one-liners (`python -c`, `node -e`, `ruby -e`, `perl -e`, `sh -c`, `bash -c`, `lua -e`, ...) and restricted-root substrings (`~/.ssh`, `~/.aws`, ...), routing the model back to the prompt-able typed file tools
- `AFK_DISABLE_BASH_INTERPRETER_GUARD` env var — lifts only the bash interpreter-eval denylist while keeping the rest of path-approval enabled
- `AFK_DISABLE_PATH_APPROVAL` env var — disables the path-approval + bash-restriction hooks entirely (for headless flows that need wide-open file access)
- `AFK_FORCE_BASH_INTERPRETER_GUARD` env var — opts headless surfaces back into the interpreter denylist

### Added
- elicit user approval for restricted-path tool calls (port afk-workshop#477) (42c013f)

### Fixed
- resolve PR #202 review findings (H1/M1/M2/L1-L4/N1-N2) (cc07c7f)

### Changed
- Merge pull request #202 from griffinwork40/afk-port/pr-477 (e443d01)
- Merge remote-tracking branch 'origin/main' into afk-port/pr-477 (d3439cb)
- Merge pull request #204 from griffinwork40/afk-port/pr-477-review (086ca4e)

## [4.16.1] - 2026-06-18

### Fixed
- default the 'afk' CLI surface to headless (7ef070d)

### Changed
- Merge pull request #205 from griffinwork40/fix/afk-surface-headless-default (0cce23f)

## [4.16.0] - 2026-06-18

### Added
- remote /abort + REPL abort-watcher + presence auto-subscribe (iteration 4) (d60342b)
- daemon renders ledger elicitations + signed write-back (iteration 3) (0cb884c)
- wire /afk toggle to the ledger elicitation channel (iteration 2) (d408f6c)
- REPL ledger-channel elicitation handler (iteration 1) (4ab9ca2)
- ledger channel foundation — record kinds + per-session HMAC (552cd01)

### Changed
- Merge pull request #203 from griffinwork40/afk/20260617-201405-0b2298 (c035e93)
- drop dead newAbortReason field, harden digestsEqual hex guard (881f7ec)
- remote-control docs + no-second-poller invariant test (iteration 5) (004ed33)

## [4.15.0] - 2026-06-17

### Added
- forward reasoning_effort for o-series models (#128) (#193) (467af9b)

## [4.14.0] - 2026-06-17

### Added
- autonomous permission mode + scrubbed Telegram reporting (#197) (b3384fe)

## [4.13.0] - 2026-06-17

### Added
- add retry/backoff for transient errors (429, 5xx) (#192) (e58b48d)

## [4.12.1] - 2026-06-17

### Fixed
- thread max_tokens into streaming request body (issue #125) (#195) (8f6b0e3)

## [4.12.0] - 2026-06-17

### Added
- diagnostic-goal handling + commit-gate terminal-state invariant (port afk-workshop#808) (c505a5f)

### Changed
- Merge pull request #196 from griffinwork40/afk-port/pr-808 (89c02ad)

## [4.11.2] - 2026-06-17

### Fixed
- StatusLine stop() clears the pre-SIGWINCH row during the resize debounce window (port afk-workshop#719) (5888d0b)

### Changed
- Merge pull request #194 from griffinwork40/afk-port/pr-719-lows (fbb3b90)
- Merge pull request #190 from griffinwork40/ci/add-docs-typecheck-build (8468e21)
- cache npm deps in docs job (dfee8dc)
- Merge pull request #191 from griffinwork40/fix/remove-shadow-verify-backport-gap-comment (f91ccd2)
- remove resolved BACK-PORT GAP comment for shadow-verify (ac3f15a)
- add docs site typecheck + build job (a9fd370)

## [4.11.1] - 2026-06-17

### Fixed
- clamp shrink-pad to anchorFloor so the slash-command dropdown can't erase the welcome banner (2367ab8)

### Changed
- Merge pull request #189 from griffinwork40/afk/20260617-062257-f74a5a (f59b5eb)

## [4.11.0] - 2026-06-17

### Added
- composition-boundary guard for shadow-verify and devils-advocate (f549407)

### Fixed
- resolve PR #187 review nits — Wave 3.5 routing + UNVERIFIED-* merge states (09a0dea)

### Changed
- Merge pull request #187 from griffinwork40/feat/composition-boundary-guard (d6a80e7)

## [4.10.0] - 2026-06-17

### Added
- gate bash by mutation, not a substring denylist (2eb6d5f)

### Changed
- Merge pull request #188 from griffinwork40/afk/20260617-053220-bbd8c1 (ccbc5ac)

## [4.9.1] - 2026-06-17

### Fixed
- add spec-compliance axis + thread stated intent to dimension agents (26f1a22)
- add spec-compliance axis to design-review verify gate (port afk-workshop#802) (188396f)

### Changed
- Merge pull request #185 from griffinwork40/fix/bundle-review-spec-compliance (16d0098)
- Merge pull request #182 from griffinwork40/afk-port/pr-802 (194d5f6)
- Merge pull request #183 from griffinwork40/afk/20260616-180623-db5293 (5376562)
- fix verified accuracy gaps across website and repo docs (0e1b05a)

## [4.9.0] - 2026-06-17

### Added
- native AFK skill-invocation JSONL writer (port afk-workshop#804) (7699403)

### Changed
- Merge pull request #186 from griffinwork40/afk-port/pr-804 (f3f4422)

## [4.8.3] - 2026-06-16

### Fixed
- exclude ask_question elicitation declines from tool-failure-density (bad0c6c)

### Changed
- Merge pull request #184 from griffinwork40/feat/improve-exclude-elicitation-declines (6ff4553)

## [4.8.2] - 2026-06-16

### Fixed
- address PR #174 review — bg-bar self-clears old rows on resize (bc67d4e)
- reset StatusLine + BackgroundStatusBar geometry on SIGWINCH to stop ghost rows (port afk-workshop#719) (44351ef)

### Changed
- Merge pull request #174 from griffinwork40/afk-port/pr-719 (4bd1dbb)

## [4.8.1] - 2026-06-16

### Fixed
- correct prerelease version compare + debounce auto-update re-trigger (port afk-workshop#801) (7ec504b)

### Changed
- Merge pull request #177 from griffinwork40/afk-port/pr-801 (d249963)

## [4.8.0] - 2026-06-16

### Added
- require durable, citation-backed evidence in terminal states (fdd2cea)

### Changed
- Merge pull request #176 from griffinwork40/salvage/audit-prompts-evidence (8ea3c80)

## [4.7.6] - 2026-06-16

### Fixed
- preserve fully-pending band-hold rows on disarm before collapse (5eb9db6)
- keep multi-line blocks visible (band-hold) when committed under a tall overlay (port afk-workshop#649) (9e6089c)

### Changed
- Merge pull request #172 from griffinwork40/afk-port/pr-649 (ab58aa0)
- Merge pull request #175 from griffinwork40/afk-port/pr-454 (3350480)
- formalize TUI invariants discipline with regression tests (port afk-workshop#454) (4d55e2d)

## [4.7.5] - 2026-06-16

### Changed
- Merge pull request #173 from griffinwork40/fix/hookregistry-provider-contract (319aeff)
- enforce SDK dependency lock via audit:sdk:check (3eb1278)
- promote hookRegistry into the dispatcher contract (12b6907)

## [4.7.4] - 2026-06-16

### Fixed
- enforce write-tool gate (config.hookRegistry was dropped by the dispatcher) (port afk-workshop#706) (c6892c6)

### Changed
- Merge pull request #170 from griffinwork40/afk-port/pr-706 (04dd653)

## [4.7.3] - 2026-06-16

### Fixed
- seal orphaned witness traces on abnormal process exit (de83b72)

### Changed
- Merge pull request #168 from griffinwork40/fix/seal-unsealed-traces-on-exit (b92676e)

## [4.7.2] - 2026-06-16

### Fixed
- stop crashing on null-content tool-call turns (non-vision) (ac0233e)

### Changed
- Merge pull request #169 from griffinwork40/fix/openai-compat-null-content-crash (572b403)

## [4.7.1] - 2026-06-16

### Fixed
- seal provider-error turns as failed, not silent success (204dff1)

### Changed
- Merge pull request #167 from griffinwork40/fix/seal-provider-error-as-failed (6e371f5)

## [4.7.0] - 2026-06-16

### Added
- add local capability tier (9bc1dc9)

### Fixed
- guard unconfigured tier selection + route per-slot baseUrl (afad68a)
- strip ask_question on non-interactive surfaces (7dd7b91)
- route all overlay repaints through setComposedOverlay (port afk-workshop#572) (25f340d)

### Changed
- Merge pull request #164 from griffinwork40/fix/strip-ask-question-noninteractive (1d8e53b)
- Merge pull request #163 from griffinwork40/afk-port/pr-572 (10800ae)
- Merge pull request #162 from griffinwork40/feat/local-model-slot (2c4f8cb)

## [4.6.2] - 2026-06-15

### Changed
- Merge pull request #160 from griffinwork40/refactor/tui-compositor-host-trim (2af6bfb)
- Merge pull request #157 from griffinwork40/afk/update-readme-memory-docs (51dee67)
- add cross-session memory guide page (df53b12)
- extract getBuffer/resetState/applyEdit from compositor host (92e0b7b)
- Merge branch 'main' into afk/update-readme-memory-docs (c8680ba)
- add a dedicated Memory section (7c82000)

## [4.6.1] - 2026-06-15

### Fixed
- resolve model alias in compact summarizer (45474da)
- restore inter-block blank separator in armed renderer (8a38d48)

### Changed
- Merge pull request #159 from griffinwork40/fix/compact-model-alias-resolution (6c607eb)
- Merge pull request #158 from griffinwork40/fix/tui-markdown-block-separator (48ff55c)

## [4.6.0] - 2026-06-15

### Added
- extend contour-shift rhythm through the mid-page sections (8d6c7f5)

### Fixed
- remove agentafk.com link from docs sidebar nav (2126d4e)

### Changed
- Merge pull request #156 from griffinwork40/website/visual-signature-3 (0f8dc2f)
- add reusable signal->depth->rise visual signature (db5cb67)

## [4.5.0] - 2026-06-15

### Added
- Ctrl+B backgrounds the running subagent; remove whole-turn detach (a43dad6)

### Changed
- Merge pull request #152 from griffinwork40/feat/ctrl-b-background-subagent (9217aa3)

## [4.4.1] - 2026-06-15

### Fixed
- render the docs nav arc glyph via a standalone SVG file (af8c741)

### Changed
- Merge pull request #151 from griffinwork40/docs/website-favicon-and-nav-links (ccc69b0)
- keep the matched wordmark legible in the docs light theme (d8c4b62)
- match the docs nav brand lockup to agentafk.com (5db9a5a)
- use main-site favicon and link out to landing page + GitHub (2e523aa)

## [4.4.0] - 2026-06-15

### Added
- accept image input on vision models (#127) (0578a95)

### Changed
- Merge pull request #134 from griffinwork40/afk/accept-images-gracefully (03852e2)
- Merge branch 'main' into afk/accept-images-gracefully (d0ef994)
- regenerate env registry docs (3123709)

## [4.3.1] - 2026-06-15

### Fixed
- add protected env tier so the agent cannot self-grant via afk.env (84e7b91)

### Changed
- Merge pull request #150 from griffinwork40/fix/agent-config-protected-env-tier (d69c177)

## [4.3.0] - 2026-06-15

### Added
- surface pending briefs nudge on AFK interactive sessions (port afk-workshop#789) (487d7ff)

### Changed
- Merge pull request #149 from griffinwork40/afk-port/pr-789 (add2dc7)

## [4.2.0] - 2026-06-15

### Added
- self-service config/env editing for the agent (06483d7)

### Fixed
- route dynamic env presence-check through env.ts (78efe1a)
- gate enableShellHooks behind human tier + harden .bak perms (02dcea1)

### Changed
- Merge pull request #146 from griffinwork40/afk/agent-config-editor (f2cd787)
- document self-service config/env editing (be051d4)
- Merge branch 'main' into afk/agent-config-editor (e0369a8)
- Merge branch 'main' into afk/agent-config-editor (5add8e5)

## [4.1.1] - 2026-06-15

### Fixed
- move transcripts into the state/ tier and honor AFK_STATE_DIR (8f50059)

### Changed
- Merge pull request #143 from griffinwork40/afk/state-folder-transcripts (b92f8f9)
- Merge pull request #148 from griffinwork40/docs/website-accuracy-fixes (a058f26)
- propagate #143 (transcripts → state/, AFK_STATE_DIR governs whole tier) (5d22797)
- fix Brave→Exa search key, document daemon --host, add /get-started (a39ef15)
- Merge branch 'main' into afk/state-folder-transcripts (372032f)

## [4.1.0] - 2026-06-15

### Added
- add Vercel Web Analytics (ab1ec1e)

### Changed
- Merge pull request #147 from griffinwork40/feat/website-vercel-analytics (efc66da)

## [4.0.1] - 2026-06-15

### Fixed
- gitignore next-env.d.ts (auto-generated by Next.js) (18c2942)
- wire docs search — add /api/search route + export structuredData (39673dc)

### Changed
- Merge pull request #140 from griffinwork40/afk-port/pr-784 (ee74eb9)
- Merge pull request #142 from griffinwork40/afk-port/pr-784-search-fix (cd076e8)
- correct doc/runtime accuracy issues from PR 140 review (407e0b8)
- serve docs at site root for the docs.agentafk.com subdomain (275cb3f)
- fix Card top-spacing — remove dead gap above card titles (614d438)
- polish — fix double headers, compact code blocks, plainer copy (2a9d1d4)
- Merge branch 'main' into afk-port/pr-784 (d42ab54)
- add proper light theme so the toggle switches a full light palette (port afk-workshop#784) (a3081df)
- redirect / -> /docs so the bare domain resolves (port afk-workshop#784) (b2d58f9)
- redesign intro — single H1, top Get-started CTA, surfaces+capabilities card grids, install code block, merged safety section (port afk-workshop#784) (f46336a)
- Merge branch 'main' into afk-port/pr-784 (1054c7d)
- add standalone Fumadocs documentation site (port afk-workshop#784) (909b919)

## [4.0.0] - 2026-06-15

### Added
- switch web_scrape search backend from Brave to Exa (882e707)

### Changed
- Merge pull request #141 from griffinwork40/switch-search-backend-brave-to-exa (9283e87)
- point .env.example at EXA_API_KEY (5b0bcd9)

## [3.112.3] - 2026-06-14

### Fixed
- inherit default subagent model (630d6ff)

### Changed
- Merge pull request #139 from griffinwork40/afk/fix-subagent-model-hardcoding (52db82c)

## [3.112.2] - 2026-06-14

### Fixed
- empty code-block placeholder emits one trailing newline (7435930)
- stop double-spacing markdown blocks in REPL/chat output (61f960e)

### Changed
- Merge pull request #138 from griffinwork40/fix/tui-markdown-block-spacing (c8c05ec)

## [3.112.1] - 2026-06-14

### Fixed
- allow late-discovered (OAuth) MCP tools past the permission gate (066b836)
- emit OAuth state param so Mintlify-style servers connect (ee38171)

### Changed
- Merge pull request #137 from griffinwork40/fix/mcp-oauth-state-param (954e570)
- Merge pull request #136 from griffinwork40/afk-port/pr-781 (ce9cd49)
- lead positioning with authorship; drop control-plane framing (port afk-workshop#781) (89af10c)

## [3.112.0] - 2026-06-14

### Added
- add /get-started skill + harden /init detection (3ca03ae)

### Changed
- Merge pull request #133 from griffinwork40/afk/implement-get-started-skill (c3ba3c7)

## [3.111.0] - 2026-06-14

### Added
- AFK-native SessionFacet substrate (port afk-workshop#779) (7ae9c1a)

### Changed
- Merge pull request #135 from griffinwork40/afk-port/pr-779 (a8772af)
- Update model names in README examples (0959fd0)
- Update description of 'haiku' agent (0d795e7)
- Clarify description of 'afk chat' command (c0227a8)
- Update permissions description for afk command (7fafa72)
- Fix command alias for interactive mode in README (ff00dfc)
- Revise README for clarity on Agent AFK features (02ffa5e)

## [3.110.1] - 2026-06-13

### Changed
- Merge pull request #129 from griffinwork40/afk/fix-issue-104-verify (cbb7aad)
- Merge pull request #132 from griffinwork40/afk/tackle-issue-23 (6a87c44)
- tail-slice thinking buffer before normalize + wrap (closes #23) (ac2f57e)
- decompose runReplLoop into phase modules (closes #104) (4c5727d)

## [3.110.0] - 2026-06-13

### Added
- honor `tools:` frontmatter as enforced allowlist (port afk-workshop#571) (b1aaf8a)

### Changed
- Merge pull request #124 from griffinwork40/afk-port/pr-571 (288bd7a)
- Merge pull request #122 from griffinwork40/afk/20260613-082858-f888c0 (30e6ddd)
- cover extraDepth>=2 spine rendering (closes #20) (110966a)
- Merge pull request #121 from griffinwork40/afk-port/pr-643 (2552478)
- strengthen per-node credential resolution coverage (port afk-workshop#643) (d2f37c4)

## [3.109.1] - 2026-06-13

### Fixed
- emit a single ellipsis when truncating spinner tips (d1da5c8)
- truncate spinner tip row by display width (2b34060)
- render user echo as a true chat bubble; label spinner tips (b430cef)

### Changed
- Merge pull request #120 from griffinwork40/afk/tackle-issue-110-private (f0c7659)
- Merge pull request #119 from griffinwork40/afk/20260612-194653-ac9eb6 (e75d067)
- lock that subagent transitions can't drop the thinking paragraph (#110) (9de83c0)

## [3.109.0] - 2026-06-13

### Added
- surface-answerability clause + BLOCKED-artifact convention (port afk-workshop#777) (684a304)

### Changed
- Merge pull request #118 from griffinwork40/afk-port/pr-777 (9e2d768)

## [3.108.0] - 2026-06-12

### Added
- add allow_custom for free-form entry in choice/multi_choice (6ae1f65)

### Fixed
- route multi_choice custom-entry on sentinel presence, not exclusivity (6afd36b)

### Changed
- Merge pull request #116 from griffinwork40/afk/20260612-152001-f038ae (85a5032)

## [3.107.0] - 2026-06-12

### Added
- classify tool failures; exclude "system said no" from failure-density (4e8c6aa)

### Changed
- Merge pull request #117 from griffinwork40/feat/tool-failure-classification (71b75e0)

## [3.106.0] - 2026-06-12

### Added
- inject measured reproducer baseline into the read-only verifier (#10) (c6e7206)

### Fixed
- register AFK_DIAGNOSE_BASELINE in env registry (a90c0da)
- align verifier prompt with its read-only tool gate (841a15c)

### Changed
- Merge pull request #8 from griffinwork40/fix/diagnose-verifier-honest-labeling (214e439)
- regenerate env-registry docs after main merge (7a65799)
- Merge remote-tracking branch 'origin/main' into fix/diagnose-verifier-honest-labeling (f33ec8b)
- Merge branch 'main' into fix/diagnose-verifier-honest-labeling (110a6ce)
- Merge branch 'main' into fix/diagnose-verifier-honest-labeling (cd2f482)
- Merge branch 'main' into fix/diagnose-verifier-honest-labeling (f661252)

## [3.105.0] - 2026-06-12

### Added
- persist the user message to the transcript at submission time (da0b955)

### Fixed
- merge the committed band across banner-eviction gaps (920b722)
- measure first-commit geometry in the commit placement regime (c5993d5)

### Changed
- Merge pull request #114 from griffinwork40/afk/i-need-more-context (f6911ad)

## [3.104.6] - 2026-06-12

### Changed
- Merge pull request #115 from griffinwork40/refactor/parse-post-targets (8c94fb8)
- parse chat --post value directly via parsePostTargets (f6ac2cd)

## [3.104.5] - 2026-06-12

### Fixed
- force version-drift upgrade after N mid-turn deferrals (975fdcc)

### Changed
- Merge pull request #112 from griffinwork40/afk/add-forced-upgrade-guard (4492f5b)
- Merge pull request #113 from griffinwork40/afk/add-system-prompt-docs (0c18471)
- handle confused follow-ups in Failure handling (dad10d6)

## [3.104.4] - 2026-06-12

### Fixed
- prevent table cut-off from row-count off-by-one and width overshoot (d86f2a2)

### Changed
- Merge pull request #111 from griffinwork40/afk/diagnose-table-cutoff (08cf729)

## [3.104.3] - 2026-06-12

### Changed
- Merge pull request #107 from griffinwork40/afk/issue-102-verify-ship (065b5b8)
- extract reusable terminal selectors (e9efc40)

## [3.104.2] - 2026-06-12

### Fixed
- defer version-drift exit while a session is mid-turn (c8846cc)

### Changed
- Merge pull request #106 from griffinwork40/afk/telegram-msg-continuation-fix (95358c6)

## [3.104.1] - 2026-06-12

### Fixed
- bind control HTTP surface to loopback by default (55a93d7)

### Changed
- Merge pull request #105 from griffinwork40/fix/daemon-loopback-bind (783a1ed)

## [3.104.0] - 2026-06-12

### Added
- add --post/--post-pr headless publishing to afk chat (port afk-workshop#769) (c439b72)

### Changed
- Merge pull request #101 from griffinwork40/afk-port/pr-769 (6869a58)

## [3.103.0] - 2026-06-12

### Added
- promote ground-state Wave 4 + ground-claim runtime-wiring mode (067b65e)

### Changed
- Merge pull request #100 from griffinwork40/feat/promote-ground-skills-to-bundle (7283f38)

## [3.102.1] - 2026-06-12

### Fixed
- correct soft-stop notice — "Send a message to continue" (d1c1427)

### Changed
- Merge pull request #99 from griffinwork40/afk/fix-ghost-text-resume (034f5ca)

## [3.102.0] - 2026-06-12

### Added
- per-binary cross-tool asset import from Claude Code / Codex (e875772)

### Fixed
- use node: specifier for readline/promises so esbuild bundles it (a619144)
- resolve PR #92 review findings (13898a4)
- resolve importFrom only from user-global config (security) (563cd92)
- surface imported skill provenance in /skills listing (d3110b1)

### Changed
- Merge pull request #92 from griffinwork40/feat/cross-tool-import (6a53b2e)
- Merge pull request #96 from LIghtJUNction/test-pin-empty-toolinput-breadcrumb (ccfac80)
- pin empty tool input breadcrumb rendering (4bc3b56)
- Merge branch 'main' into feat/cross-tool-import (24bed64)

## [3.101.1] - 2026-06-11

### Fixed
- stop finalizeOrchestrator nuclear-flushing in-flight subagent blocks (#95) (bab6bb2)

## [3.101.0] - 2026-06-11

### Added
- record root-session model in witness traces (#91) (e8ce193)

## [3.100.1] - 2026-06-11

### Fixed
- reserve final column in echo path to fix prompt tripling (#94) (755987b)
- web_scrape failure logging (#24) + tar create/append gating (#6) (#89) (eec4b92)

### Changed
- document subagent context injection contract (#93) (4755b92)

## [3.100.0] - 2026-06-11

### Added
- inline ghost-text tab autocomplete for mid-sentence skill names (#90) (81abc62)

## [3.99.1] - 2026-06-11

### Fixed
- ESC soft-stop cancels on first press, no post-cancel lag (#81) (6b0e586)

## [3.99.0] - 2026-06-11

### Added
- distinctive user message display in scrollback (#88) (10eacfd)

## [3.98.1] - 2026-06-11

### Fixed
- stop local-model subagent dispatch from hanging (#87) (2d458dc)

## [3.98.0] - 2026-06-11

### Added
- add closure-anomaly guardrail + eval-run contract (abort subtype) (#86) (03cfc86)

## [3.97.0] - 2026-06-11

### Added
- return browser_screenshot as a model-visible image (#82) (e9a51b0)

## [3.96.1] - 2026-06-11

### Fixed
- stop user-card echo ghosting by reserving the terminal last column (#85) (23200c2)

## [3.96.0] - 2026-06-11

### Added
- add eval-run, the first deterministic eval-case validation stage (#84) (86ae118)

## [3.95.0] - 2026-06-11

### Added
- drive the user's real Chrome via chrome-devtools-mcp (afk browser connect) (#83) (ee76c5f)

## [3.94.1] - 2026-06-11

### Fixed
- align REPL slash verbs with CLI (install / install-plugin) (port afk-workshop#701) (#79) (9899a6f)

## [3.94.0] - 2026-06-11

### Added
- act on telemetry — loop guard, skill-depth hint, enable tool-failure-density (#80) (5255350)

## [3.93.1] - 2026-06-11

### Changed
- split terminal-compositor + bug-hunt pass (#78) (b9d49e5)

## [3.93.0] - 2026-06-10

### Added
- add /config and /doctor slash commands (port afk-workshop#702) (#77) (907dc5f)

## [3.92.4] - 2026-06-10

### Fixed
- schedule live-sync no longer fails silently: `create_schedule`/`cancel_schedule` results now include `daemonSynced` + `syncDetail` (and a `syncNote` when the change will only apply on the next daemon start); transient `afk daemon --once` runs no longer overwrite-then-delete the service daemon's port-discovery file (new `writePortFile` option + content-guarded unlink); daemon `POST /tasks` accepts `cronExpression` as an alias for `cron`; creating a disabled schedule no longer live-registers it into the running daemon; `afk schedule` CLI subcommands (add/remove/enable/disable) now surface live-sync status via the shared http-client instead of failing silently; creating a disabled schedule now sends an idempotent DELETE to unregister any stale live daemon registration; `afk schedule add --disabled` now matches the tool handler (idempotent DELETE instead of an unconditional POST) so a disabled task is never live-registered into — and fired by — a running daemon; the CLI `add`/`enable` live-sync now forwards `notifyOn` so a (re)registered task keeps its notification setting until the daemon reloads from disk

### Fixed
- stop schedule live-sync from failing silently; guard the shared port file (#76) (3c44511)

## [3.92.3] - 2026-06-10

### Fixed
- commit content to scrollback in banner sessions — eliminates blank-gap, duplication, and lost-commit regressions when the REPL prints a banner before arming (#74) (2411b88)
- never reap a worktree hosting a live session (#73) (6f82cb8)

## [3.92.2] - 2026-06-10

### Fixed
- force-checkout managed cache to survive dirty mirror (#49) (22e8277)

### Changed
- Port afk-workshop#756: add fix:pins hash-pin regen + check (#69) (c38a12c)
- shadow-verify: confidence-trigger, three-way verdict, bounded retry (#52) (e6f65b2)

## [3.92.1] - 2026-06-09

### Fixed
- repair skill-dispatch turn rendering and accounting regressions (#68) (61d377c)

## [3.92.0] - 2026-06-09

### Added
- OSC 8 hyperlinks on tool-lane file paths — clickable without layout change (#67) (155d415)
- durable per-session event ledger + Telegram /watch live-tail (#66) (fb5a593)

## [3.91.0] - 2026-06-09

### Changed
- `/plan off` now exits plan mode, saves the plan you developed to a markdown file under `<cwd>/.afk/plans/`, and implements it — replacing the closure-summary ritual (which only emitted a 3-section recap to the transcript). The mode flips to `default` *before* the seeded turn so writes are permitted for the save + implementation. Shift+Tab still exits plan mode without saving or implementing (the manual-takeover escape hatch). The deferred-flip `pendingPlanExit` machinery is removed.

### Added
- /plan off saves the plan to a file then implements it (#55) (266249d)

## [3.90.2] - 2026-06-09

### Added
- telegram: configurable outbound notification routing via `telegram.notify` in afk.config.json (`mode`, `primaryChatId`, `targets`) plus `AFK_TELEGRAM_NOTIFY_MODE` / `AFK_TELEGRAM_PRIMARY_CHAT_ID` env overrides. New pure resolver `src/telegram/notify-routing.ts`.

### Changed
- telegram: outbound notifications (daemon alerts, `send_telegram`, OAuth prompts, `/review`, digests) now default to a single **primary** chat — the first private/DM chat in `AFK_TELEGRAM_ALLOWED_CHAT_IDS` — instead of broadcasting to every allowed chat. Separates the inbound allowlist (who may command the bot) from outbound delivery. Single-chat setups are unaffected; multi-chat setups can restore fan-out with `mode: "broadcast"` (or `AFK_TELEGRAM_NOTIFY_MODE=broadcast`).

### Added
- route outbound notifications to a primary chat, not all allowed chats (#54) (e542bb2)

### Fixed
- strip orphaned bold markers in verdict cards; dedupe deferred row (#65) (917ac66)

## [3.90.1] - 2026-06-09

### Fixed
- route subagent overlay refreshes through OverlayComposer (#63) (baf325d)

## [3.90.0] - 2026-06-09

### Added
- add Claude Fable 5 (claude-fable-5) (#64) (cdbc3f1)

### Fixed
- recompute git workspace state per read instead of freezing at session start (#62) (05b5174)

### Changed
- extract compositor frame composition to frame.ts (#61) (9f5c54e)
- awa-bundled/shadow-verify: skip adversarial re-derivation on text-terminal sessions (#57) (fad6885)

## [3.89.11] - 2026-06-09

### Fixed
- surface the skill name in the tool lane (#59) (a8728f1)

## [3.89.10] - 2026-06-09

### Fixed
- emit honest closure reasons (truncated, hook_blocked, max_turns_exceeded) (#60) (19206fe)

## [3.89.9] - 2026-06-09

### Fixed
- clamp max_tokens to model ceiling and guard thinking budget (#58) (7d02d4b)

## [3.89.8] - 2026-06-08

### Fixed
- ship uses --body-file/-F instead of heredoc-in-$() (#53) (a89b9db)

### Changed
- isolate no-auth tests from host credentials via AuthResolverDeps injection (#56) (5be979f)

## [3.89.7] - 2026-06-08

### Fixed
- unblock native browser tools in the bundled ESM binary (#51) (fa29619)

## [3.89.6] - 2026-06-08

### Fixed
- re-pin committed band on overlay collapse to kill the blank-space gap (#50) (5c76889)

## [3.89.5] - 2026-06-08

### Fixed
- wire ProviderRouter into the REPL so /model crosses provider families (#47) (eca4ed2)

### Changed
- Port afk-workshop#643: resolve compose node credentials by node model (#46) (f5fde53)

## [3.89.4] - 2026-06-08

### Fixed
- resolve session credential by session model, not env default (#42) (0959c40)
- harvest argument-hint flags so /review --post completes (#48) (9d43b98)

## [3.89.3] - 2026-06-08

### Changed
- reorder + dedup framework system prompt (Stage 1) (#45) (0de370b)

## [3.89.2] - 2026-06-08

### Fixed
- enforce read-only tool gating for recon skills (ground-state) (#5) (6aeeaaa)

## [3.89.1] - 2026-06-08

### Fixed
- make TerminalCompositor wrap-aware so soft-wrapped frame lines don't clobber committed text (#39) (a7ace49)

## [3.89.0] - 2026-06-08

### Added
- per-model ProviderRouter — switch models across providers in one session, no AFK_PROVIDER (#38) (ab87afc)

### Fixed
- stop streaming markdown tables leaving ghost rows in the live overlay (#40) (a632844)

## [3.88.0] - 2026-06-08

### Added
- Responses API + ChatGPT-subscription OAuth + user-configurable model slots (#33) (fe0ba5d)

## [3.87.1] - 2026-06-07

### Fixed
- keep verdict card's closing border visible in tight frames; ASCII-safe affordances (#32) (9e08de4)

### Changed
- control-plane reframe — README hero + package metadata (#37) (caf39da)
- Port afk-workshop#734: feat(cli): add `afk trace show` — human-readable witness trace reader (#36) (71b0f35)
- Port afk-workshop#733: feat(cli): add /review --post {github,telegram} publishers (#35) (7830a0f)

## [3.87.0] - 2026-06-07

### Added
- layer operator config over an unconditional framework base (#34) (ff03920)

## [3.86.0] - 2026-06-07

### Added
- push full redacted task response to Telegram (#31) (dd73b2e)

## [3.85.0] - 2026-06-07

### Added
- trim /resume from startup welcome hint (#18) (a64aa7b)

### Fixed
- make auto-release push atomic to prevent orphaned tags (#30) (4bd20e8)
- sanitize Brave error body before embedding (#26) (d9df988)
- collapse orchestrator progress map to at-most-one entry (#27) (0e79887)
- repaint REPL prompt on fresh interactive session (#15) (108a383)

### Changed
- Port afk-workshop#689: feat(cli): process-wide stdin-claim guard (phantom-turn root-cause fix) (#28) (39ce1c7)
- Port afk-workshop#727: fix(service): launchd daemon crash-loops (exit 127) — bake PATH into plist; + correct --trigger help (#25) (b675e78)

## [3.84.1] - 2026-06-06

### Fixed
- unblock pre-auth CLI commands; require Node >= 22 (#16) (10ddd77)

### Changed
- Remove codex reference from README (5394b09)

## [3.84.0] - 2026-06-06

### Added
- redesign /skills listing + detail UX (phase 1) (#14) (cf5e6f0)

## [3.83.1] - 2026-06-06

### Fixed
- clamp diff body lines to terminal width in nested tool-lane paths (#9) (a3b38b5)

## [3.83.0] - 2026-06-06

### Added
- flip default skill execution from fork to load (#7) (0deb564)

### Changed
- Update SKILL.md (d987a3e)
- Add context field to review skill documentation (13a5ae6)

## [3.82.0] - 2026-06-05

### Added
- flip gather + parallelize to context: load (#4) (4006c37)

## [3.81.1] - 2026-06-05

### Fixed
- anchor flat-leaf tool roots with col-0 ◉ beside a nesting root (#3) (c1d84e0)

## [3.81.0] - 2026-06-05

### Added
- add auto-release workflow for automated versioning and publishing (4d93403)

### Fixed
- make HOT.md non-fatal — truncation covenant (#2) (0f91a0f)

### Changed
- hermetically lock AFK_INTERNAL tier in audience-gate tests (#1) (aeeaa41)
- Update README to simplify API key instructions (02ba5f9)
- Revise README for clearer description of Agent AFK (a7da9ce)
- Initial public release — Agent AFK (0a23cff)

## [3.80.6] - 2026-06-05

### Fixed
- exclude internal-tier skills from the published npm bundle (#713) (952079a3)

## [3.80.5] - 2026-06-04

### Fixed
- emit literal apostrophe in OG meta to stop Reddit double-encoding (#712) (3c634593)

### Changed
- Open-core relicense: Apache-2.0 + DCO + community files (#691) (3e4e4200)

## [3.80.4] - 2026-06-04

### Fixed
- ship bundled-plugins (the `awa-bundled` orchestration skills) in the published npm tarball — `build:dist` (the publish path) never copied `src/bundled-plugins/`, so `npm install` got zero bundled skills; both build paths now route through one shared copy helper, guarded by a unit test and a `publish-bundle` CI assertion (#703) (00211e3)
- emit twitter:url meta tag (last #514 migration parity gap) (#710) (05e24c3)

## [3.80.3] - 2026-06-04

### Fixed
- restore #502 session-player terminal + 2 copy regressions (#709) (be1e214b)
## [3.80.2] - 2026-06-04

### Fixed
- keep non-last ancestor spine continuous through nested subtrees (#708) (983d06f0)

## [3.80.1] - 2026-06-04

### Fixed
- retry mid-stream 529 / overloaded_error events (#704) (04aca58)

## [3.80.0] - 2026-06-04

### Added
- add /name command to show or set the session name (#700) (d5bca28e)

## [3.79.0] - 2026-06-04

### Added
- config-driven shell-command hooks + TUI clear-band reset (reconciles #644 + #646) (#693) (cde08779)

## [3.78.1] - 2026-06-04

### Fixed
- correct stale settings — models, codex removal, thinking enum (#699) (c5825b3)

## [3.78.0] - 2026-06-04

### Added
- add tool call counting script and corresponding npm command (207eaff)

## [3.77.1] - 2026-06-03

### Fixed
- harden rate-limiter against XFF spoofing + non-POST token burn (#698) (4f3ae30)

## [3.77.0] - 2026-06-03

### Added
- migrate vanilla landing page to Next.js 15 App Router (#514) (02adee41)

## [3.76.1] - 2026-06-03

### Fixed
- topology-spine seam — keep live-ancestor columns open in committed band + overlay (#687) (f1024e5)

## [3.76.0] - 2026-06-03

### Added
- @-file picker — tilde/absolute path completion + content injection (#688) (10aa3a00)

## [3.75.0] - 2026-06-03

### Added
- replace Firecrawl with local Readability/Turndown scraper + Brave search (#671) (8158044)

## [3.74.0] - 2026-06-03

### Added
- provider-level readOnlyMemory enforcement for child sessions (#690) (8853eb0)

## [3.73.1] - 2026-06-03

### Fixed
- scope audit-fit Glob rule, thread ship heal iters (#692) (619e4ad)

## [3.73.0] - 2026-06-03

### Added
- durable named sessions + Telegram→CLI resume bridge (phases 1–2) (#672) (44c60e4)

## [3.72.0] - 2026-06-03

### Added
- add /fork to branch a conversation into a parallel session (#670) (5e24f1a)

## [3.71.3] - 2026-06-03

### Fixed
- silence depth-2 nesting ghost row (recursive no-visible-descendant) (#678) (9ff5060)

## [3.71.2] - 2026-06-03

### Fixed
- silence headerEmitted nested-skill overlay label leak + lock spine continuity (#662) (a2ffb17b)

### Changed
- extract key-dispatch cluster from terminal-compositor (KeyDispatchHost) (#669) (435f2937)

## [3.71.1] - 2026-06-03

### Fixed
- stop hiding @-file completions past the dropdown cap (#667) (73c4c5a6)

### Changed
- decompose TerminalCompositor — extract paste, autocomplete, render, committed-band clusters (#665) (fb501146)

## [3.71.0] - 2026-06-03

### Added
- default `afk --worktree` to the remote default branch (origin/main) (#666) (8c055dd)

## [3.70.8] - 2026-06-03

### Fixed
- count cached tokens in context-window % and auto-compact (#648) (b2e428c6)

## [3.70.7] - 2026-06-03

### Fixed
- clamp each banner line to terminal width (#664) (f64049e1)

## [3.70.6] - 2026-06-03

### Fixed
- bundle poller entrypoint + resolve bundled dist layout (#663) (cd4faa2)

### Changed
- relocate per-model credential resolver to agent layer (#658) (a01a259)

## [3.70.5] - 2026-06-02

### Fixed
- collectSkillEntries() scans user + project skills fresh from disk (#656) (9553467c)

## [3.70.4] - 2026-06-02

### Fixed
- fork-time credential fallback to parent's cached token (#657) (a5ca163c)

## [3.70.3] - 2026-06-02

### Fixed
- advance branch-tracked installs by commit, not ref-name (#655) (dc627f9)

## [3.70.2] - 2026-06-02

### Fixed
- poll-retry the no-ts 429 path so same-account resets auto-resume (#638) (c5258c8)

## [3.70.1] - 2026-06-02

### Fixed
- drop stale resize ghost-erase snapshot on shrink (#653) (94c48366)

## [3.70.0] - 2026-06-02

### Added
- cross-provider REPL ghost-text suggestions (#606) (babeac5f)

## [3.69.3] - 2026-06-02

### Fixed
- erase old frame + committed band on terminal resize (stop ghost rows) (#650) (bfa9e3bb)

## [3.69.2] - 2026-06-02

### Fixed
- preserve committed lines + close scrollback gap when band caps under tall overlays (#645) (cf18529a)

## [3.69.1] - 2026-06-02

### Fixed
- reset committed band on /clear to prevent transcript resurrection (#647) (459f03e2)

## [3.69.0] - 2026-06-02

### Added
- instrument startup-latency session_phase waterfall (follow-up to #637) (#639) (21a90466)

## [3.68.0] - 2026-06-02

### Added
- pin the verdict-ledger rail to its own reserved footer row (#629) (98eb8e73)

### Fixed
- resolve subagent/skill child credentials by child model (#640) (e305d0fa)

## [3.67.2] - 2026-06-01

### Fixed
- anchor childless NESTING overlay heads with ◉ (fix floating-spine bug) (#642) (3c708ae)

## [3.67.1] - 2026-06-01

### Fixed
- heal footer bars + re-pin full committed band after full-screen scroll (#641) (8120a5ad)

## [3.67.0] - 2026-06-01

### Added
- add session_phase waterfall events + session_sealed subagent token rollup (#637) (fec76ed)

## [3.66.0] - 2026-06-01

### Added
- public/internal tier gate via audience field + AFK_INTERNAL (#569) (e4a3490e)

## [3.65.0] - 2026-06-01

### Added
- add context: 'load' in-context skill execution mode (#630) (e87293f5)

### Changed
- sync review skill with upstream example-plugin (close #441) (#635) (62207782)

## [3.64.0] - 2026-06-01

### Added
- enrich /reload-plugins output with plugin versions, source breakdown, and reload delta (#636) (f572365)

## [3.63.0] - 2026-06-01

### Added
- pin loop-stage rail as reserved footer row via LoopStageBar (#634) (ea469d40)

## [3.62.0] - 2026-06-01

### Added
- add bundled /refactor structural-change skill (#633) (8f2cff6)

## [3.61.0] - 2026-06-01

### Added
- add bundled /simplify code-simplification skill (#631) (cb16af7)

## [3.60.7] - 2026-06-01

### Fixed
- ESC soft-stop registers on first press and stops dropping the next message (#626) (4d6dc92)

## [3.60.6] - 2026-06-01

### Fixed
- re-pin committed band above frame on overlay shrink (#627) (e82c10dc)

### Changed
- unify card/error/usage boxes onto the drawBox primitive (#628) (fb6418bf)
- move loop-stage rail to bottom of live overlay (#625) (419f91c6)

## [3.60.5] - 2026-06-01

### Fixed
- strip terminal_font_size from skill-dispatch sub-agents + anchor review arg (#624) (e70a8f9)

## [3.60.4] - 2026-06-01

### Fixed
- born-named worktrees — defer creation to first turn, never move a live worktree (#617) (322d6c3d)

## [3.60.3] - 2026-06-01

### Fixed
- match shadow-verify orchestrators at word boundaries (#623) (0b2105d)

## [3.60.2] - 2026-06-01

### Fixed
- clamp over-wide drawBox titles + extend sanitizer test coverage (#622) (89adbbf)

## [3.60.1] - 2026-06-01

### Fixed
- strip OSC/DCS/C1 escapes from bash/grep/subagent tool output (#621) (4719a771)

## [3.60.0] - 2026-06-01

### Added
- extract canonical terminal sanitizer + add drawBox primitive (#620) (20f457e)

## [3.59.1] - 2026-05-31

### Fixed
- stop skill-dispatch sub-agents from asking "which skill?" (#619) (8da8808)

## [3.59.0] - 2026-05-31

### Added
- ack inbound with 👀 reaction + clean-final streaming mode (#615) (df6eefb0)

## [3.58.0] - 2026-05-31

### Added
- interleave per-phase thinking summaries on TTY (#614) (c38aabf2)

## [3.57.1] - 2026-05-31

### Fixed
- frame ask_question as a last resort, not a first move (#616) (1ca68136)

## [3.57.0] - 2026-05-31

### Added
- `!cmd` shell-passthrough with foreground + background modes (#565) (c8dbe1e9)

## [3.56.5] - 2026-05-31

### Fixed
- ESC soft-stop no longer auto-fires a phantom turn (#611) (d8ee37a)

## [3.56.4] - 2026-05-31

### Fixed
- preserve URLs in tool-lane arg rendering (#612) (2fe02ee)

## [3.56.3] - 2026-05-31

### Fixed
- align nested subagent thinking-tail with its tool children (#613) (da53956)

## [3.56.2] - 2026-05-31

### Fixed
- report 1M context window for opus_1m/sonnet_1m aliases (#610) (f3a138fa)

### Changed
- extract spinner state machine into SpinnerController (#609) (b6659b38)

## [3.56.1] - 2026-05-31

### Fixed
- /tokens always shows 0 tokens and NaNm total (#607) (b0945e7)

### Changed
- decompose 590-line dispatchKey into ordered handler methods (#608) (d56e50a)

## [3.56.0] - 2026-05-31

### Added
- truncate large pastes into compact placeholders (#574) (4a79762)

## [3.55.1] - 2026-05-31

### Fixed
- single-copy commitAbove + hasCommitted-gated evict-on-growth (#592) (92211df)

## [3.55.0] - 2026-05-31

### Added
- wire default witness trace writer into daemon + Telegram sessions (#604) (0319ebe4)

## [3.54.0] - 2026-05-31

### Added
- refresh context usage in status line mid-turn (#527) (a41d882b)

## [3.53.6] - 2026-05-30

### Fixed
- remove 5-min timeout, abort is sole unblock path (#602) (96dcce4)

## [3.53.5] - 2026-05-30

### Fixed
- substitute $ARGUMENT/$ARGUMENTS in plugin SKILL.md body (#566) (10b821b)

## [3.53.4] - 2026-05-30

### Fixed
- wire skill/agent/compose executors into daemon sessions (#595) (cd033635)

## [3.53.3] - 2026-05-30

### Fixed
- route /ground-state as a pre-write trigger, not "exploratory" (#598) (4c912c8)

### Changed
- change hero eyebrow pill from 'Any model' to 'CLI' (#600) (793a954)

## [3.53.2] - 2026-05-30

### Fixed
- enforce read-only contract via hard-constraint prompt (#596) (15d3e10c)

## [3.53.1] - 2026-05-30

### Fixed
- clear stale compositor overlay on /clear and /info (#594) (1827bd50)

## [3.53.0] - 2026-05-30

### Added
- improve bot UX (items 2–8) (#588) (5b00421d)

## [3.52.1] - 2026-05-30

### Fixed
- preserve typed buffer as queued on ESC soft-stop (#593) (0f496a48)

### Changed
- extract types/helpers from terminal-compositor.ts (#591) (8c08c27d)

## [3.52.0] - 2026-05-30

### Added
- queue messages during compaction (#586) (f7976ab9)

## [3.51.2] - 2026-05-30

### Fixed
- allow get_runtime_state in read-only phase forks (#584) (86b00561)

## [3.51.1] - 2026-05-30

### Fixed
- inject advisory-lock path to de-flake CI tests (#582) (297d51e6)

## [3.51.0] - 2026-05-29

### Added
- inject SKILL_ROOT + validate names per agentskills.io spec (#578) (ff6a09e3)

## [3.50.2] - 2026-05-29

### Fixed
- erase every row in commitAbove Phase 1 to stop multi-line splice (#581) (99ff7ec6)

## [3.50.1] - 2026-05-29

### Fixed
- compositor respects bg status bar reserved rows (#575) (78579649)

### Changed
- drop duplicate test gate to eliminate self-hosted double-load (#580) (2fccfe73)
- split rendering god-classes into coherent modules (#573) (21eab719)
- bump default testTimeout to 15s (#579) (460ab1d8)

## [3.50.0] - 2026-05-29

### Added
- migrate opus default to claude-opus-4-8 (#576) (f225660)

## [3.49.0] - 2026-05-29

### Added
- namespace-normalized drift comparison for bundled SKILL.md (closes #440) (#570) (d73b396b)

## [3.48.0] - 2026-05-29

### Added
- highlight /mint in mint green ;) (#577) (a582e7a)

## [3.47.1] - 2026-05-29

### Fixed
- route between-turn slash output through persistent compositor (#564) (2422a227)

## [3.47.0] - 2026-05-29

### Added
- integration branch — #510 + #531 + re-enable (#563) (ec4fbd53)
- allow memory_search in child allowlist (#567) (a0b46f74)

### Fixed
- compute NEXT version from LAST_TAG, not package.json (0d9e65ec)
- make auto-release race-safe (atomic push + tag-list sort) (f7a9871c)
- don't inherit <command-name> routing in sub-agent prompts (#568) (c4d0690a)
- print last-turn banner so users see context after screen clear (#455) (3ee3c90b)

### Changed
- Update project description in AFK.md (d268d95d)
- gate toolchain setup on bump!=none in auto-release (#562) (7b194d7e)
- move playwright from optionalDependencies to dependencies (#561) (ca7cafd6)
- add dev-only invariant guard (follow-up to #557) (#559) (1db191b2)
- dedupe LAUNCHCTL_TIMEOUT_MS + fix docstring mode mismatch (#558) (86c686e0)
- split launchd.ts into per-concern modules (#505) (1a3048ba)

## [3.45.3] - 2026-05-28

### Fixed
- allow live frame to visually shrink (ratchet fix) (#557) (326ca92)

## [3.45.2] - 2026-05-28

### Fixed
- close two soft-stop races — arm-to-handler window + late-ESC after done (#544) (b0ba748)

## [3.45.1] - 2026-05-28

### Fixed
- echo reasoning_content on assistant turns for thinking-mode providers (#549) (0bf93d8)

## [3.45.0] - 2026-05-28

### Added
- auto-delete worktree on zero-turn session exit (#556) (f72ef7e)

## [3.44.0] - 2026-05-28

### Added
- native browser-control tools (Phase 1) (#553) (aaf8b11)

## [3.43.1] - 2026-05-28

### Fixed
- plugin-skill forward path runs preflights symmetrically (#476) (0720782)

## [3.43.0] - 2026-05-28

### Added
- Phase 2 — workspace baseline, presence files, `afk sessions` command (#548) (74a39ac)

## [3.43.0] - 2026-05-28

### Added
- Phase 2 — workspace baseline (\`workspace\` view in \`get_runtime_state\`): branch, HEAD SHA, dirty count, remote URL (33a8935)
- Phase 2 — session presence files at \`~/.afk/state/presence/\`; top-level sessions write on start, remove on exit (33a8935)
- \`afk sessions\` command: list active presence-file sessions in a table (33a8935)

### Fixed
- Provider-aware API key routing: \`getApiKey()\` no longer leaks Claude OAuth token into openai-compatible Bearer header (33a8935)
## [3.42.6] - 2026-05-28

### Fixed
- bound user-card height + repair frame-shrink orphan rows (110d8dc)

## [3.42.5] - 2026-05-28

### Fixed
- honor ESC soft-stop in runSkillDispatchTurn's stream loop (5ee73b8)

## [3.42.4] - 2026-05-28

### Fixed
- add get_runtime_state to permission allowlists (16e5446)

### Changed
- update waitlist welcome email copy (e3f9a0d)

## [3.42.3] - 2026-05-28

### Fixed
- regenerate env-registry docs with AFK_DEBUG_COMPOSITOR entry (acd251c)
- emit \x1b[2K before Phase 1 CUP-positioned text write (4ffd15c)

## [3.42.2] - 2026-05-28

### Fixed
- honor late-ESC after done event — suppress turn-complete (e5ace8c)

## [3.42.1] - 2026-05-28

### Fixed
- plug Claude-OAuth-token leak into openai-compatible Bearer (d17fb89)

## [3.42.0] - 2026-05-28

### Added
- Phase 1 — get_runtime_state tool + session identity fragment (5590e9d)

### Fixed
- patch PR #542 review — externalTools reach, cwd sanitisation, permissionMode bucket, depth contract (566f7ed)

## [3.41.3] - 2026-05-28

### Fixed
- preflight collision check + preamble bleed recovery (340aed1)

## [3.41.2] - 2026-05-28

### Fixed
- safety-net tool flush owns its trailing blank (44a1c2c)
- harden rhythm-contract assertions against silent regressions (12f5fe0)

### Changed
- unify vertical spacing under single-owner trailing rhythm (451717e)
- add code-vs-runtime dual-referent signal class (#541) (0e596ca)

## [3.41.1] - 2026-05-27

### Fixed
- restore declared anchorRow on rearm; assert eviction-before-render ordering (4b959d2)
- floor commitAbove CUP target at anchorRow so first echo skips banner (deda6e2)
- protect pre-arm scrollback rows from CUP-positioned frame overwrite (d6a6df0)

### Changed
- lock spine topology at Bug #5 regression site (d01aac8)

## [3.41.0] - 2026-05-27

### Added
- ESC soft-stop — halt stream, preserve completed work (e4f9cd0)

### Changed
- banner hint says Esc instead of Ctrl+C (670ea00)

## [3.40.1] - 2026-05-27

### Fixed
- align subagent thinking-tail with tool-child content column (9b71491)

## [3.40.0] - 2026-05-27

### Added
- readline-parity word/line navigation in TerminalCompositor (39d0cdc)

### Fixed
- scrub ANSI/control bytes from subagent label extraction (6dbe791)
- summarize agent/Task/skill JSON args to stop spine JSON leak (9a1626b)
- route PAGER through env registry to satisfy audit:env:check (4807fda)

### Changed
- update .gitignore and add TypeScript environment file for Next.js (3c2435e)
- temporarily disable ask_question built-in tool (ccb51d2)

## [3.39.3] - 2026-05-27

### Fixed
- close arm-window race + add shrink-path coverage (57cf89e)
- reset CupFrameRenderer geometry on SIGWINCH to stop ghost rows (0a56d8d)

### Changed
- add Vercel analytics to landing page (ff7bbaa)

## [3.39.2] - 2026-05-27

### Fixed
- restore cursor visibility when CupFrameRenderer frame write fails (8b56a9c)

### Changed
- document log-update fallback invariant on StreamingMarkdownRenderer (48a6927)
- replace trivially-passing newline-count with render-spy frame inspection (05b65bf)

## [3.39.1] - 2026-05-27

### Fixed
- enhance scrollback functionality for visible text accumulation (9cc4c55)
- make scrollback actually reach the terminal scrollback buffer (1c00a0a)

## [3.39.0] - 2026-05-27

### Added
- add /transcript command to view full session in $PAGER (d2f72db)

## [3.38.0] - 2026-05-27

### Added
- add optional `cwd` param for per-call worktree isolation (717b0a6)

## [3.37.0] - 2026-05-27

### Added
- provider-agnostic routing — AFK_PROVIDER + env-hint + third-party prefixes (84e1dfc)

## [3.36.5] - 2026-05-27

### Fixed
- enforce read-only permission boundary on spec/research/plan phases (1fa7a54)

## [3.36.4] - 2026-05-27

### Fixed
- throttle overlay repaints + park cursor at DECSTBM bottom anchor (f3ef030)

## [3.36.3] - 2026-05-27

### Fixed
- park clear() cursor at rows-1 so commitAbove pushes scrollback (9690b9f)

## [3.36.2] - 2026-05-27

### Fixed
- strip resume-context from config in reset() so /clear starts fresh (8eabebe)

## [3.36.1] - 2026-05-27

### Fixed
- route ask_question elicitation through compositor onSubmit (f4beb24)

## [3.36.0] - 2026-05-27

### Added
- close anthropic-direct parity gaps (U1+U2+I1-I3) (b8d99e5)

### Changed
- split render.ts into per-component modules (25dd6f3)

## [3.35.0] - 2026-05-27

### Added
- append agentafk.com footer to changelog Threads posts (5574130)

## [3.34.0] - 2026-05-27

### Added
- auto-send welcome email via Resend on signup (ebda376)

## [3.33.0] - 2026-05-26

### Added
- add tool-failure-density detector (b9c2ef3)

## [3.32.2] - 2026-05-26

### Fixed
- verdict-card off-by-2 overflow causing broken bordered completion box (0a2a885)

## [3.32.1] - 2026-05-26

### Fixed
- forward cwd through skill and depth-2 subagent dispatch (d25315e)

## [3.32.0] - 2026-05-26

### Added
- rebuild hero terminal as session-player with goblin mascot (#502) (9b67f40)

### Changed
- update AFK.md for provider rename and DAG executor status (83ca176)

## [3.31.0] - 2026-05-26

### Added
- declare AgentSession.abort() on IAgentSession (d5f9a00)

### Fixed
- runtime-guard AgentSession.abort against reserved reasons (e79609e)
- classify SIGINT/SIGTERM/SIGHUP as abort, not model_end_turn (d4a2dea)

### Changed
- cover signal-handler -> session.abort wiring (37d43bf)

## [3.30.2] - 2026-05-26

### Fixed
- forward backgroundRegistry to forked child SubagentExecutors (6a13aff)

## [3.30.1] - 2026-05-26

### Fixed
- colorize slash-command submit echo on compositor path (362e785)

## [3.30.0] - 2026-05-26

### Added
- add AFK Dark VS Code / Cursor editor theme (a9af988)

## [3.29.3] - 2026-05-26

### Fixed
- forward image attachments through plugin-skill dispatch (b0f014c)

## [3.29.2] - 2026-05-26

### Fixed
- align Blocked directive bullets with parser needles (e689a82)
- inject end-of-turn directive in code, not prompt file (beba476)

### Changed
- remove duplicate end-of-turn block + update stale mock (0be1835)

## [3.29.1] - 2026-05-26

### Fixed
- add absence-claim grounding, lower shadow-verify threshold (9edc34a)

### Changed
- enlarge waitlist count pill for stronger social proof (2017d98)

## [3.29.0] - 2026-05-26

### Added
- elicitation REPL prompt + Telegram inline-keyboard surfaces (36e4cb6)
- ask_question built-in tool + elicitation router serial queue (6823914)

### Fixed
- close PR #451 review blockers — router hang + skip-contract docs (1954a47)
- resolve all PR #451 hard blockers and medium issues (c7469d7)
- resolve remaining blockers + mediums from ask_question PR #451 review (73ad745)
- close shadow-verify gaps from PR #451 resolve pass (3be7523)
- resolve 3 blockers + 5 mediums from ask_question PR review (8e0e475)

## [3.28.1] - 2026-05-26

### Fixed
- paint stage rail once per event — drop pre-switch repaint (e821db1)

## [3.28.0] - 2026-05-26

### Added
- add topic tag to Threads release posts (391f799)

## [3.27.6] - 2026-05-26

### Fixed
- update waitlist call-to-action and placeholder text (71edd9c)

## [3.27.5] - 2026-05-26

### Fixed
- route Threads changelog post to release-dedicated account (#493) (7c6a0a6)

## [3.27.4] - 2026-05-26

### Fixed
- insert blank row between chrome and input prompt (#490) (b89b092)
- unbreak Threads changelog post — timeout race + shell quoting (#489) (5b6179f)

## [3.27.3] - 2026-05-26

### Fixed
- add structured `truncated` flag on ToolResult for overflow detection (#481) (8b6c49a)

## [3.27.2] - 2026-05-26

### Fixed
- keep cwd live across worktree-autoname rename (#488) (8134f98)

### Changed
- move tool-result rendering upstream of truncation + bash JSON summary (#484) (6ba4e63)
- Update waitlist button label to remove arrow for improved clarity (940a1e9)
- Update waitlist count label for improved clarity and engagement (4f986d6)
- Update hero section text and button label for improved clarity and branding consistency (2ab1fb0)
- Revise hero section description for clarity (0495578)

## [3.27.1] - 2026-05-26

### Fixed
- guard teardown errors in skill-executor finally blocks (703d57e)
- seal child skill sessions and handle SIGHUP (22ed629)

## [3.27.0] - 2026-05-26

### Added
- auto-post changelog to Threads on tag push (f09ef31)

## [3.26.2] - 2026-05-26

### Fixed
- repair tool-lane topology spine across three severing sites (#470) (935cfdd)

## [3.26.1] - 2026-05-26

### Fixed
- skip CUP anchor on first arm() to eliminate banner→prompt gap (72b6c41)

## [3.26.0] - 2026-05-26

### Added
- surface skip reasons with dim diagnostic line (b55a7bb)

### Fixed
- resolve short model aliases before SDK send (0a2af18)

## [3.25.2] - 2026-05-25

### Fixed
- update toolInput format in stream-renderer and turn-handler tests (5ca0379)

## [3.25.1] - 2026-05-25

### Fixed
- address 7 review findings from PR #449 (#467) (d82b43a)

## [3.25.0] - 2026-05-25

### Added
- emit tool.overflow_kill on bash/grep SIGKILL (#475) (75accba)

## [3.24.1] - 2026-05-25

### Fixed
- re-issue CUP anchor on terminal resize so REPL frame survives SIGWINCH (#453) (88e3180)

## [3.24.0] - 2026-05-25

### Added
- capture-mode for clean demo recordings + multi-file diff separators (#426) (0174a6d)

## [3.23.1] - 2026-05-25

### Fixed
- drop breadcrumb labels — anonymous anchors in live overlay (3f54014)

## [3.23.0] - 2026-05-25

### Added
- cap diff flush output at 30 lines with AFK_DIFF_LINES escape hatch (3b2de51)
- add stdin input + session resume for headless parity (634710b)
- add stream-json output format for headless consumers (ca4dc0c)
- left-anchored subagent topology spine with ◉ turn-root (d025508)

### Fixed
- address PR #447 review — 4 highs + 5 mediums (335b2b0)
- address 3 blockers and 5 medium issues from PR #419 review (4c5632c)
- clamp orchestrator-root overlay lines to terminal width (5bb0458)

### Changed
- Merge pull request #447 from griffinwork40/feat/diff-flush-cap (6972db4)
- Merge branch 'main' into feat/diff-flush-cap (b667502)
- resolve origin/main into feat/diff-flush-cap for PR #447 (4a8e86f)
- Merge branch 'main' into afk/20260520-085208-212510 (76fc918)
- swap tree connectors to ├─ / ╰─ for spine renderer (039891c)

## [3.22.0] - 2026-05-25

### Added
- replace Jina with Firecrawl as markdown/search upstream (0f1581a)

## [3.21.1] - 2026-05-25

### Fixed
- restore [queued] suffix so Enter mid-stream gives feedback (23d5dae)

## [3.21.0] - 2026-05-25

### Added
- Sprint 3 — replay-mode eval-gen + eval-cases CLI (83288c6)
- Sprint 2 — template-mode propose + closure/subagent detectors + triage (f26b298)

## [3.20.4] - 2026-05-25

### Fixed
- unstick REPL after usage-limit auto-resume (#448) (cd45c94)

## [3.20.3] - 2026-05-25

### Fixed
- preserve multi-line clipboard paste in compositor (7b1d33a)

## [3.20.2] - 2026-05-25

### Fixed
- loud-fail empty fenced code blocks with placeholder text (2b7b68f)

## [3.20.1] - 2026-05-25

### Fixed
- reset scan cache on update so new SKILL.md is visible without restart (F2) (7f2f8bc)
- require name+description keys explicitly in generate.md (56d665c)

## [3.20.0] - 2026-05-25

### Added
- auto-cd parent shell into preserved worktree on exit (b2b0d71)

### Fixed
- address shell-init review — H1/H2 portability, M1/M4 correctness (fb2af1d)
- harden cd-on-exit marker and shell-init wrapper after PR review (71970e8)

## [3.19.0] - 2026-05-25

### Added
- emit skill.dispatched/completed for inline registry skills (57994eb)

### Fixed
- stream photo download with size cap instead of buffering (7407e12)

### Changed
- repair corrupted lock file from aborted schema migration (7ec2f27)
- remove obsolete .afk-worktree-meta.json file (1d4b153)

## [3.18.2] - 2026-05-25

### Fixed
- apply dropdown selection on Enter — Stage 3e port gap (54c5a37)

## [3.18.1] - 2026-05-25

### Fixed
- clamp duration at 0 on clock skew (review C2) (9f98c44)
- cap duration at thinking→acting boundary + render above response (f3ee1a3)

## [3.18.0] - 2026-05-25

### Added
- add /font-size REPL command sharing terminal_font_size handler (52aa482)
- add terminal_font_size built-in tool (97c3849)

### Fixed
- emit trailing blank after subagent done-block (42d8be5)
- prefer last verdict within tier (qualify self-correction) (546b1ea)
- generator sub-agent is tool-less; wire generate.md prompt (11d3b8d)

## [3.17.3] - 2026-05-25

### Fixed
- anchor overlay breadcrumb spine with dim ◉ marker (c13a1fe)
- add headerEmitted guard to renderFlushChildren (a021a7d)

### Changed
- long-comment prefix convention + targeted comment shrinks (1fffa7c)

## [3.17.2] - 2026-05-24

### Fixed
- mirror formatAgentSummary spine topology in formatAgentHeader/Children (#450) (34b76fe)

## [3.17.1] - 2026-05-24

### Fixed
- route AFK_SKILL_STREAM_VERBOSE through env.ts (post-merge audit gap) (4a02a16)
- unblock CI on PR-416 — install.test fake + AGENT_AFK_ASCII env registry (952060b)
- close PR-416 review findings — hook bypass, HTTPS gap, Git ≥2.31 dependency (c9e2660)
- plugin install hardening — HTTPS-only, git hook suppression, install warning, skill prompt-loader path guard (S7-step1/P3) (1e845ac)

## [3.17.0] - 2026-05-24

### Added
- left-anchored subagent topology spine with ◉ turn-root (#350) (1bab3bf)

## [3.16.0] - 2026-05-24

### Added
- wire persistent compositor into REPL — Stage 3e (4e28e5d)
- InputSurface armCompositor lifecycle + idle-mode compositor semantics (f0c129f)
- port bracketed-paste + clipboard image attachments to TerminalCompositor (9e7dc88)
- StreamRenderer can borrow a TerminalCompositor; promptText accepts () => string (1be7b9a)
- add idle input mode + onSubmit hook to TerminalCompositor (9dab928)
- thread promptText through StreamRenderer → compositor (c5bebc7)

### Fixed
- wire skill onCancel through borrowed compositor with capture+restore (a855dc0)
- route in-stream notifications through completionWriter (extends ed4318b) (38bf6b1)
- clear autocompleteState before persistent-compositor repaints (50632aa)
- anchor first log-update frame at terminal bottom in compositor.arm() (ce1dcfe)
- render dim breadcrumb for headerEmitted ancestors so live children don't appear orphaned (H4) (efbdaf8)
- preserve in-flight subagent rows when orchestrator emits content chunks (H3) (1a0dece)
- isolate borrow-dispose cleanup steps so setSpinner throw cannot strand stale overlay (7729dab)
- address PR #424 review findings (H1–H8, M1, M4, M6, M7, L2) (03d1f89)
- close Stage-3e compositor duplication — borrow path + post-arm raw writes (ed4318b)
- widen setInputMode flush invariant to any → idle (3241dba)
- agent-turn input parity — slash colorization, always-on caret, Tab applies dropdown (8f95d0c)

### Changed
- Merge pull request #424 from griffinwork40/afk/20260523-120253-4b3e3e (920ad3c)
- Merge branch 'main' into afk/20260523-120253-4b3e3e (4f02680)
- extract createSkillRenderer factory + fix latent /init borrow bug (53950e0)
- Merge branch 'main' into afk/20260523-120253-4b3e3e (c4b374d)
- add InputSurface ↔ TerminalCompositor integration coverage (f3c441e)
- make slash Writer route-aware via optional WriterSink (03518e8)
- introduce InputSurface as the long-lived REPL input abstraction (8cf9393)

## [3.15.0] - 2026-05-24

### Added
- handle photo messages with optional caption (b71c12a)

### Fixed
- apply PR #396 review blockers — capability guard, SSRF URL assert, gate reorder (6979270)
- resolve PR #396 review blockers — token leak, busy-spin, MIME sniff, tautological test (9f2a703)
- resolve PR #396 security and reliability blockers (152e162)
- apply PR #396 review fixes (85ad3dd)

### Changed
- regression tests for busy-spin cascade gate (PR #396) (a07882a)

## [3.14.0] - 2026-05-24

### Added
- add stream-json output format (#419) (69a0bf8)

## [3.13.3] - 2026-05-24

### Fixed
- aggregate timeout, production-visible warn, dispatch defaults (9543b6b)
- hook dispatch timeout + subagent fork AbortGraph cleanup (R3/R4) (a7ab48d)

## [3.13.2] - 2026-05-24

### Fixed
- isolate pnpm/action-setup dest per-job to runner.temp (e3874d0)

## [3.13.1] - 2026-05-24

### Fixed
- populate ProviderUsage.durationMs on every turn.completed yield (07bbe2a)
- bound cwd-fallback tests to tempDir, not process.cwd() (0714f67)

## [3.13.0] - 2026-05-24

### Added
- add drift test + port cwd anchor to ship (71f65a3)
- centralized env-var registry + audit gate (#429) (8edd275)
- route child sessions via providerForModel (263e25e)
- handle oauth-limit-no-ts 429, /reauth slash command, account info in pause card (4c02593)

### Fixed
- remove duplicate proc.on close handler that broke logic (991dedb)
- bump .brand__wordmark font-size to 19px (59f7e3f)
- tool-lane truncation, bash exit-code labeling, skill partial-output preservation (#423) (ac537a4)
- 6 bugs from 463k-token MLX overrun — allow-list, context clamp, mlx-community limits (f2b200f)
- address PR #412 review feedback — process-group kill, descendant test, token formula, non-blocking polish (f1e9bc5)
- bash SIGKILL on timeout/abort + auto-compact formula drops cache fields (S10/P5) (bb7eade)
- resolve /review 425 F1+F2+F3 blockers (2004fc7)
- resolve all HIGH/MEDIUM PR review blockers on V8 overflow guard (31c848b)
- guard grep and bash handlers against V8 max-string-length crash (799e7a7)
- route OpenAI-parent subagents to OpenAICompatibleProvider (ab0a7fa)
- plugin skill slash commands dispatch via skill-invocation payload, not raw text (fe21349)
- actually rebuild SDK client on hot-swap + wire /reauth to swap running session (a68cbaa)
- suppress overlay re-render of already-committed ancestor headers (4725717)

### Changed
- route auto-release + publish to self-hosted runner (411c483)
- drop #4ade80 from changelog favicon, swap to accent-soft (5603702)
- persistence reframe + contour-layer + 2nd signal-field (168edbe)
- lock #4ade80 to success-state, trim .access::before to 1 radial (bcaaf49)
- surface memory feature in hero typewriter + runtime section (5adbebb)
- Remove comment on brand wordmark font size (962e598)
- bump topbar logo mark from 28px to 34px (1e09d03)
- route lint-build + test to self-hosted runner (mac-afk-1) (4d9d3ba)

## [3.12.1] - 2026-05-23

### Fixed
- address PR #415 follow-ups (exit code, unref, prod logging) (81f1628)
- reliability micro — runInBackground catch, close await, waitForReset unref, farm finally (R1/R2/R5/R6) (56dadef)

## [3.12.0] - 2026-05-23

### Added
- add /cd command to set per-chat working directory (e563d12)

## [3.11.1] - 2026-05-23

### Fixed
- prose-question guard (H1) + codebase lane override (H2) (#418) (78c9ec3)

### Changed
- remove vestigial bootstrap scripts (#421) (545dce4)

## [3.11.0] - 2026-05-23

### Added
- dead-owner verdict, /worktree slash, boot-time auto-prune (#364) (2bf6d41)

## [3.10.5] - 2026-05-23

### Fixed
- plugin install/remove invalidate scan cache + removePlugin name guard (F2/S8) (b57a066)

## [3.10.4] - 2026-05-23

### Fixed
- AFK_HOME validation + migrateDirOnce EXDEV fallback (F1/F5) (f617705)

## [3.10.3] - 2026-05-23

### Fixed
- extend write denylist with AFK config + tool tokens (S4) (01b2ba8)

## [3.10.2] - 2026-05-23

### Fixed
- auth wizard no-echo + creds/transcript 0o600 (S1/S2/S3) (#413) (4dddba7)

### Changed
- git rm test-bot files + correct CLAUDE.md runDAG description (S16) (#409) (7f7b7d9)

## [3.10.1] - 2026-05-23

### Fixed
- propagate worktree cwd into subagents and preflights (#408) (c61a5a1)

## [3.10.0] - 2026-05-23

### Added
- auto-compaction (opt-in) + SDK dependency lock (#405) (f9e052a)

## [3.9.1] - 2026-05-23

### Fixed
- preserve cursor across DECSTBM toggles in withFullScrollRegion (#407) (f962403)

## [3.9.0] - 2026-05-23

### Added
- background-subagent TUI parity (Ctrl+B hints, per-job status rows, auto-deny elicitations) (#362) (d2e5f8f)

## [3.8.10] - 2026-05-23

### Fixed
- forbid direct push to default branch + invented convention (63f3ed3)

## [3.8.9] - 2026-05-23

### Fixed
- bump pinned qualify hash to match merged rule-5 paragraph (#399 follow-up) (1f5c587)

## [3.8.8] - 2026-05-23

### Fixed
- re-wrap streaming TUI overlay on terminal resize (220060b)

## [3.8.7] - 2026-05-23

### Fixed
- inline Copy button on install command, drop forced overflow (35ac697)

### Changed
- explain why rule 5 systematically fires on gate/guard skills (e6cbf29)

## [3.8.6] - 2026-05-23

### Fixed
- narrow skill anti-recursion guard to same-skill only (436620e)

## [3.8.5] - 2026-05-23

### Fixed
- emit subagent.completed/.failed for background dispatches + fork-throws path (1a8172a)

## [3.8.4] - 2026-05-23

### Fixed
- accept null in hypothesis schema, tighten prompt (810bf18)
- clamp thinkingTail rows to terminal width (ab7f8b9)

## [3.8.3] - 2026-05-23

### Fixed
- preserve attachment indicator after message submit (1ab1d57)

## [3.8.2] - 2026-05-23

### Fixed
- guard user-echo writes against DECSTBM sub-region scroll loss (9d516e7)

## [3.8.1] - 2026-05-23

### Fixed
- label-aware overflow — count honesty, sibilant plural, sanitize (ef51ee4)

## [3.8.0] - 2026-05-23

### Added
- P04 trace instrumentation around runPreflight (f9fb92f)
- wrap plugin-forward manifest in <system-reminder> (999d856)
- wire plugin-forward path + review-pr preflight (8982c79)
- wire native skill handler + optional manifest block (586cffe)
- add SkillInvocation types + registry (67b1dad)

### Fixed
- H2/H3/H4/M2 — PR #317 review blockers (22fb669)
- C03/C04/A03/F12 small correctness and documentation (1988d7d)
- P02/P03/F08/F10/F11/C05 review-pr hardening (8f3ed6a)
- P01/P05/F07 artifact-dir — rate-limited prune, warn logging, random fallback id (8276e8f)
- F04/F05/F06 filesystem safety hardening + T02 tests (5211786)
- C01 — preflight only runs on plugin-forward path, not native slash commands (9e980e2)
- F01/F02/F03 security chain + C02 registry key correction (5cbe1a6)
- prune artifact dirs older than 7 days on each call (ae26ca7)

### Changed
- Merge pull request #317 from griffinwork40/afk/20260518-preflight-deferred (62971f0)
- Merge branch 'main' into afk/20260518-preflight-deferred (7ff04bb)
- Merge branch 'main' into afk/20260518-preflight-deferred (2b806fb)
- Merge remote-tracking branch 'origin/main' into HEAD (0e12b97)
- T03/T04/T05 additional coverage (b40df4b)
- A01/A02/A05/T06 registry test-isolation + explicit init (6d36849)
- remove unnecessary as-unknown-as sessionId cast (ef20153)
- Merge remote-tracking branch 'origin/main' into afk/20260518-055423-b599b7 (a37a979)

## [3.7.3] - 2026-05-23

### Fixed
- guard label-aware overflow against pre-merge placeholders (8c8cae2)
- preserve dispatch labels in tool-lane overflow (f396d73)

## [3.7.2] - 2026-05-23

### Fixed
- preserve isolated newline deltas in streaming TTY renderer (8357dda)

## [3.7.1] - 2026-05-22

### Fixed
- normalize case + scope tier-3 regex locally (b919d23)
- tighten verdict parser — tier-2 modifier gap + tier-3 nearby-anchor fallback (ff1a78a)

## [3.7.0] - 2026-05-22

### Added
- Phase 1A — read-only witness-trace scanner + failure cards (eee58d4)

### Changed
- skip setOverlay repaint when overlay text is unchanged (28cfe3b)

## [3.6.0] - 2026-05-22

### Added
- render live thinking overlay as a wrapped paragraph (ba42900)

## [3.5.0] - 2026-05-22

### Added
- add npm install command with copy button to #access section (#384) (b8a292b)

## [3.4.0] - 2026-05-22

### Added
- add MCP client support — stdio + remote (HTTP/SSE) + OAuth + live refresh (#374) (a3e8c4c)

## [3.3.4] - 2026-05-22

### Fixed
- propagate traceWriter through SkillExecutor + surface wall-clock in Done summary (#378) (6721351)

## [3.3.3] - 2026-05-22

### Fixed
- close 4 schema gaps surfaced by telemetry audit (#383) (c42481c)

## [3.3.2] - 2026-05-22

### Fixed
- defensive verdict parsing + write-step name-collision guard (#382) (a66d8fd)

## [3.3.1] - 2026-05-22

### Fixed
- summarize bash JSON output + move tool-result rendering upstream of truncation (#380) (1f33c1a)

### Changed
- PR #376 follow-ups (f430388)

## [3.3.0] - 2026-05-22

### Added
- surface visible extended thinking on Opus 4.7 + default to max effort (824015a)
- route HF-style org/model ids to openai-compatible (a95111c)

### Fixed
- widen effort=max default to opus-4-6/sonnet-4-6 + fix effort beta header value (1632b33)
- stop flag dropdown from auto-popping on every space (fc100ee)
- suppress 💡 suggestion echo when it duplicates the response (39fecb0)

## [3.2.1] - 2026-05-22

### Fixed
- eager-emit ancestor frame headers in ToolLane.flushSource (2c2e103)

## [3.2.0] - 2026-05-21

### Added
- route Messages traffic through a local Anthropic-compatible server (#239) (2578100)

## [3.1.0] - 2026-05-21

### Added
- hydrate stats + welcome banner on session resume (#316) (2142890)

### Changed
- add founder anecdote + finalize 'Built by' credit (#308) (139bc02)

## [3.0.1] - 2026-05-21

### Fixed
- launchctl-throws test uses telegram, not daemon (b2341b0)

## [3.0.0] - 2026-05-21

### Breaking
- **`SlashContext.session` type changed from `AgentSession` to `SessionRef`** (breaking for external slash-command authors). Update any direct reads of `ctx.session.<method>` to `ctx.session.current.<method>`. All built-in handlers have been migrated. Required to make the mid-session swap mechanism transparent to slash commands through a stable pointer. (#355)
- **Tool schema wire-boundary projection.** Internal `AnthropicToolDef` fields (`category`, `concurrencySafe`, `riskClass`) are now stripped at the wire boundary via a `WireToolDef` projection; the Messages API call signature is narrower. External code synthesizing tool definitions should target `AnthropicToolDef` (rich, internal) — the projection happens inside the provider. (#367)
- **Layering rehome.** `keychain`, tool-category classification, telegram error predicates, and `upsertEnvVar` moved out of `src/cli/` / `src/telegram/` to their canonical homes (`src/agent/auth/`, `src/agent/tool-category.ts`, `src/utils/`). Re-export shims preserve backward-compat for known internal callers; deep imports into old paths from external code may need updating. (#361)

### Added
- **`afk service install/uninstall/status`** — macOS LaunchAgent install for always-on `afk telegram` / `afk daemon` (auto-start on login, relaunch on crash). Paired with `/service-setup` skill that walks the user through install end-to-end. (dc69966, dfcedff, #346)
- **Pixel-art goblin mascot** in the interactive loading screen via half-block renderer (10×10 sprite, pupils + cheek highlights). (#354)
- **Loading-screen tips + dropdown tooltip hints** in the CLI for first-run discoverability. (#294)
- **Daemon pull-trigger mode** with a queue store — daemon can now drain a persisted queue instead of cron-only execution. (issue #337, slice 1)
- **OpenAI-compatible provider REPL surface parity** with anthropic-direct (streaming, tool dispatch, auth diagnose). Closes the GPT/o-series migration off the legacy openai-codex provider. (3e932be)
- **PLUGIN_ROOT env** injected into plugin-skill subagent processes so vendored plugin assets can resolve their own root.

### Fixed
- **`tools.0.custom.<field>: Extra inputs are not permitted`** 400 from the Anthropic Messages API — internal tool classification metadata no longer leaks across the wire. (#367)
- **`/review` api-compat false positives** on dead code — added a reachability pre-check so removed-but-unused exports stop firing the api-compat dimension. (#349)
- **`/ground-state` charter drift** — read-only contract is now enforced inside `SKILL.md` so the skill cannot mutate state. (c7321cb)
- **Plugin sandbox escape via symlink** — `assertWithinPluginsDir` now `realpath`s both `parentDir` and `dest`'s `dirname` before the containment check. (#339)
- **Skill-frame teardown on child `flushSource` drain** — child-stream completion no longer orphans the parent skill frame. (a6758c0)
- **Subagent stream-renderer leak on error** — throttle entry is now cleaned up on the error path. (bbe85be)
- redact credential-shaped strings in resume-swap error reasons (PR #355 H-1/H-2 follow-up) — SDK 401/403 errors during `buildSession` or `waitForInitialization` no longer echo `Bearer` / `sk-ant-…` to the terminal.
- guard `stored.startedAt` with `?? Date.now()` fallback so legacy stored sessions saved before the field existed do not produce `NaN` status-line durations after `/resume`.
- reset the verdict ledger (terminal-state trajectory rail) on `/resume` — outgoing session trajectory no longer contaminates the resumed session.

### Changed
- **`query.ts` decomposed** into single-responsibility units: `repairOrphanToolUses` (5e2de54), `SessionState` bag (e456201), `AbortCoordinator` (739d600), `RetryLayer` for OAuth 401 + 429 (5d2fa8d), and `compactHistory` handler (95bf4b9). Zero behavior change; the monolith is gone.
- **Schema-as-source-of-truth for tool classification.** `SAFE_TOOLS`, `WRITE_TOOLS`, and the read-tool predicate are now derived from `AnthropicToolDef.{category, concurrencySafe, riskClass}` rather than 6+ drifting hand-maintained lists. (#361)
- **`sumProviderUsage` promoted** out of a provider-specific location to `src/agent/usage.ts` so both providers share the same accumulator. (c481852)
- **Operator-legibility phase 1 polish** across the interactive surface. (7fa2773)

### Known
- `/allow-dir` filesystem grants persist across `/resume` — the underlying `AnthropicDirectProvider` is process-scoped (constructed once at bootstrap, reused by the swap), so its `_sharedReadRoots` cache survives session boundaries. This is intentional given the current API surface (no `resetGrants` exists). To revoke grants, exit and restart `afk`.

## [2.33.0] - 2026-05-20

### Added
- unify REPL input surface across user and agent turns (38c1bde)
- footer mark + complete Twitter card tags (d4cadb8)
- Handoff Arc brand identity — bigger, brand-able mark + favicon family + OG card (cff7409)
- phase reducer + test-runner detector + risk classifier (pure-function trio) (f9fb3f4)

### Fixed
- address PR #332 review — 2 bugs + 2 test gaps (98266ca)
- repair orphan tool_use blocks to prevent 400 on next turn (d14f347)
- anchor inline-handler subagents under their skill's lane entry (a265bbd)
- correct-by-construction HTML conversion via placeholder pass (0ed4a79)

### Changed
- v2.32.0 (efaf032)
- split tool/chrome roles and retheme code-block syntax (7518a73)
- split blue-family palette across semantic roles (c238b78)

## [2.32.0] - 2026-05-20

### Added
- phase reducer + test-runner detector + risk classifier (pure-function trio) (f9fb3f4)

## [2.31.1] - 2026-05-20

### Fixed
- unblock npm publish by deflaking `/tasks` recency-sort test — `BackgroundAgentRegistry.register()` returns a snapshot copy, so post-register `startedAt` mutation was a no-op; on fast CI the sort fell back to insertion order. Test now stubs `Date.now()` before each `register()` so the live `InternalJob.startedAt` carries the intended timestamp.

## [2.31.0] - 2026-05-20

### Added
- route GPT/o-series to openai-compatible + retire openai-codex (slice 5/5) (8ae2ab9)
- wire openai-compatible provider + auth diagnose command (slice 4/5) (6e94ec5)
- tool dispatch via SessionToolDispatcher (slice 3/5) (4e8e935)
- text-only streaming end-to-end (slice 2/5) (ddfd623)
- auth resolver + diagnostic (slice 1/5) (9ee440a)

### Changed
- Merge pull request #304 from griffinwork40/feat/openai-compatible-provider (858d9fb)
- Merge branch 'main' into feat/openai-compatible-provider (65995e6)

## [2.30.0] - 2026-05-20

### Added
- Phase 3 — tool schemas, handlers, CLI command, handler tests (05ff23d)
- Phase 2 — daemon integration (notifyOn, REST routes, port file, load-persisted) (e3a7aa4)
- Phase 1 — data layer (schedule-store + paths + tests) (523736b)

### Fixed
- materialize notifyOn='failure' default at write time (f272608)

### Changed
- throttle-gate markdown render + fire-and-forget PostToolUse (9b03eb0)

## [2.29.4] - 2026-05-20

### Fixed
- zombie-state hardening for background work + Haiku 4.5 pricing (5e4c376)

## [2.29.3] - 2026-05-20

### Fixed
- chronological interleave for subagent done-blocks (#328) (8ba83ea)

## [2.29.2] - 2026-05-20

### Fixed
- forward image attachments through slash commands (C+D hybrid) (961539f)

## [2.29.1] - 2026-05-20

### Fixed
- tighten KEY=value replacer to avoid misleading length=0 (#214) (9c96379)
- refresh lastActivity on inflight createSession rejection (#213) (881903e)
- redact secrets in scheduler errorMessage (#212) (74e99b8)

### Changed
- unit tests for assertSafePluginName / assertWithinPluginsDir (#216) (5062a68)
- document POSIX-dead startsWith('/') as Windows guard (#215) (7db4bc6)

## [2.29.0] - 2026-05-20

### Added
- wave 4 — executor wiring + create-session-factory (daf6e5f)
- wave 3 — reply sink posts replies via threads CLI (752aef6)
- wave 2 — classify, route, dispatch per-user agent sessions (5657b45)
- add polling-based mention ingress (wave 1: read path) (6476164)

### Fixed
- close shared MemoryStore on daemon shutdown (36b2cd0)

## [2.28.0] - 2026-05-20

### Changed
- **edit_file tool result format** — `tool_result` content for `edit_file` is now a single-line message (e.g. `Replaced 1 occurrence in path/to/file`). The diff context previously appended after a double-newline (`${resultMsg}\n\n${diffContext}`) is no longer included in `tool_result` content; it is emitted out-of-band as a `tool_diff` event (CLI-only render channel). Consumers that parsed the multi-line format must update accordingly. (#313)

### Added
- inline colored diffs for edit_file/write_file (#313) (6fbb370)

### Changed
- Shorten hero eyebrow pill so it doesn't wrap on mobile (1b2175c)
- async-first hero copy + SEO meta updates (#312) (2dda5f4)

## [2.27.1] - 2026-05-19

### Changed
- `afk daemon` is now invokable without `--task` or `--cron`; trigger defaults to `sessionstart` and task defaults to `/forge-friction --auto` when neither flag, env var (`AFK_DAEMON_TASK`), nor `afk.config.json` `daemon.task` provides a value (closes Daemon Gap B)
- `afk daemon --cron <expr>` (without an explicit `--trigger`) now auto-selects `cron` trigger mode, matching the intent of providing a cron expression
- `afk.config.json.example` updated to show the `daemon.task` / `daemon.taskId` fields

### Fixed
- default trigger to sessionstart; pass --cron flag through (Gap B) (#311) (bdf3ef9)

## [2.27.0] - 2026-05-19

### Added
- unify /tasks across turn-detach and subagent-job facilities (20b8d2b)
- wire BackgroundAgentRegistry into BackgroundStatusBar (8295f2d)
- add EventEmitter surface to BackgroundAgentRegistry + BackgroundItem union (8b12d8b)
- cap concurrent jobs + TTL eviction + cancel-source attribution (03ae081)

### Fixed
- improve join() eviction error message (M-1) + TTL eviction tests (M-3) (d2977aa)
- store cancelSource per-job to fix cascade attribution dead code (H-1) (7f6ba33)
- add CANCEL_DRAIN_TIMEOUT_MS to cancelAll() to prevent teardown hang (C-2) (05da7f6)
- wire setTasksRegistry in repl-loop bootstrap (C-1) (9afd4c9)

### Changed
- add BackgroundJobCapError teardown coverage (H-2) (a5c2a8b)
- clarify Phase 3 commit message drafting process (a895e5f)

## [2.26.7] - 2026-05-19

### Fixed
- add Dispatch protocol section to enforce parallel sibling dispatch (68e88d5)

### Changed
- narrow /mint routing trigger and demote from lead bullet (e36a9db)

## [2.26.6] - 2026-05-19

### Fixed
- add Write-step invariants to prevent skill_name="unknown" silent-failure (c303850)

## [2.26.5] - 2026-05-19

### Fixed
- resolve PR #321 review blockers and majors (95c04dc)

### Changed
- emit in-flight badge inline via completionWriter (d612533)

## [2.26.4] - 2026-05-19

### Fixed
- distinguish 'nothing-to-summarize' from 'history-too-short' (72e31c2)
- resolve session-stuck and malformed-HTML regressions (P0) (352f46d)

## [2.26.3] - 2026-05-19

### Fixed
- correct-by-construction fixes for fenced code, ordered lists, hr, blockquote (bab3b09)

## [2.26.2] - 2026-05-19

### Fixed
- trailing newline after lists + ordered-list start-number honoring (108a5b6)

### Changed
- regression tests for ordered-list renumbering + trailing newline (6e0a7ec)
- rewrite README for the npm audience; move dev docs under docs/ (de2b70a)
- align package metadata with proprietary status (0842463)
- memoize disk-tier reads on the cold-start path (fd4e0cc)

## [2.26.1] - 2026-05-19

### Changed
- tool-output render registry; memory tools summarized via `chunk.display` upstream of truncation

### Fixed
- bash tool-lane no longer leaks truncated raw JSON for commands like `gh pr view --json`; structured JSON output renders as `{key1, key2, …}` / `[N items]` via the render registry
- move tool-result rendering upstream of truncation + bash JSON summary (#302) (5c1b220)

## [2.26.0] - 2026-05-19

### Added
- skill-invocation plumbing — types, registry, native handler, plugin-forward, review-pr (#287) (0cb3e72)

## [2.25.3] - 2026-05-19

### Fixed
- improve handling of pre-aborted signals (abaf41a)

### Changed
- Delete .github/workflows/claude.yml (0fce048)
- Delete .github/workflows/claude-code-review.yml (c87d4b5)

## [2.25.2] - 2026-05-19

### Fixed
- retry transient 529/503 errors with exponential backoff (b846a8e)

## [2.25.1] - 2026-05-19

### Fixed
- auto-start bot after allowlist save (95378a7)
- resolve bot entrypoint in bundled dist layout (816c8d2)

## [2.25.0] - 2026-05-19

### Added
- background mode for fire-and-forget subagent dispatch (#288) (e970152)

### Fixed
- close JSDoc above backgroundRegistry field (db2b97a)

### Changed
- soften hero terminal prompts (d6d9765)
- rename web_fetch tool to web_scrape (ed7115b)

## [2.24.0] - 2026-05-18

### Security
- sanitise all MCP-server-controlled strings (server name, message, URL, elicitation id,
  field descriptions, type names, enum values, field keys) at the terminal-write boundary;
  extends ANSI sanitiser to cover OSC sequences (`ESC ] … BEL/ST`) and 8-bit C1 controls
  (`0x80–0x9F`, including C1 CSI `0x9B`) (#277, follow-up to #275)
- filter `__proto__` / `constructor` / `prototype` keys from MCP schema; build accept
  payload via `Object.create(null)`; spread to plain object at return — defence-in-depth
  against JSON-route prototype pollution from a malicious MCP server (#277)

### Changed
- **BREAKING (REPL elicitation):** form-mode request with no usable schema properties now
  returns `{ action: 'decline' }` instead of inventing `{ action: 'accept', content:
  { response: <text> } }`. The synthetic `response` key was not in the MCP spec and
  risked server-side schema rejection. (#277)
- form-mode optional-field skip now surfaces `fieldDef.default` in the accept payload
  when a default is declared; previously the key was omitted regardless of whether a
  default existed. The downstream guard `outcome.value !== undefined` still omits the
  key when no default is declared, preserving "user skipped" semantics for the
  no-default case. (#277)

### Fixed
- `afk telegram start` now resolves the bot entrypoint in the published flattened
  bundle layout (`dist/telegram.mjs` as sibling of `dist/cli.mjs`). Previously the
  resolver assumed the tsc layout (`dist/telegram/manager.js` + `dist/telegram.js`)
  and threw `Telegram entrypoint not found` on every global install, making the
  bot unstartable from `afk telegram start` / `pnpm telegram:start` /
  `/telegram-setup`. Priority order: bundled `.mjs` sibling → tsc `.js` one-up →
  dev `.ts` one-up. Bundled wins when both layouts coexist because spawning the
  unbundled `dist/telegram.js` would re-import deps the bundle inlined.
- `/telegram-setup` skill now auto-starts the bot after saving the allowlist
  instead of asking. The bot is the whole point of setup; the previous "want me
  to start it? (yes/no)" step left users stuck wondering why their messages
  weren't being received.
- trim input before checking `:cancel` / `:decline` escape hatches; previously
  `' :cancel '` fell through as a literal value, trapping required fields in an
  unbounded loop (#277)
- required field absent from `schema.properties` now declines with a diagnostic before
  prompting any field, instead of silently producing a schema-invalid accept payload (#277)
- between-field abort detection: form-mode now checks `signal.aborted` at the top of
  each field prompt and between outer-loop iterations, so an abort fired in the
  microtask gap between fields is honoured before the next prompt label is printed (#277)
- cap form-mode `required[]` array iteration at `MAX_FIELDS * 2` to bound allocation
  on a malicious 1M-element required list (#277)
- emit a one-shot warning when `MAX_FIELDS=64` or `MAX_ENUM_VALUES=256` caps trigger,
  so users can diagnose why a partial form or rejected enum value appears (#277)
- `synthesizeAgentEntry` now computes `maxWidth` and passes it through to both
  Agent-creation paths (`ToolLane.mergeAgentLabel` and `addStartWithAgentContext`);
  previously both passed `undefined`, causing `formatToolLine` to skip truncation on
  narrow terminals (#277)

### Tests
- add direct unit tests for `sanitizeSchemaString` (`src/cli/_lib/sanitize.test.ts`)
  covering identity, Unicode preservation, 7-bit CSI, OSC, C1 controls, and truncation
  semantics (#277)
- add TTY-path coverage for `handleSubagentEvent` asserting compositor `setOverlay`
  fires on tool_use_detail and that subagent prose does not leak into parent scrollback
  on TTY (#277)

### Added
- preserve @ in file dropdown + highlight @path tokens in buffer (c4e448e)

### Changed
- redesign hero into 2-column grid with anchored social proof (c8ec384)
- simplify header to Changelog + Join waitlist CTA (9b1a8cd)
- cap section padding so trimmed content isn't dwarfed (93f77b1)
- salvage non-overlapping wins from #298 (48b873e)
- Feat/form mode elicitation (#284) (1819add)

## [2.23.0] - 2026-05-18

### Added
- three-layer upgrade safety — postinstall kill, error sanitization, version drift check (3232f90)

### Changed
- accept "sure" as approval signal alongside approve/yes/lgtm (5d2fc5a)

## [2.22.2] - 2026-05-18

### Fixed
- reduce text density and increase breathing room (#297) (04f74a9)

## [2.22.1] - 2026-05-18

### Fixed
- Escape dismisses dropdown; uniform muted color for all trigger kinds (#282) (789f108)

## [2.22.0] - 2026-05-18

### Added
- cap live overlay at 6 root rows with elision summary (#276) (862cf1b)
- implement access waitlist form and update access section messaging (e265bbb)

### Fixed
- restore seedBuffer auto-submit fast-path (regression from e51ec5d) (#292) (1ba7976)

### Changed
- remove aliases from /changelog command and update related tests (a3ee0e6)

## [2.21.0] - 2026-05-18

### Added
- Day 4b + 4c + 4d — inline-button digest + Discard/Diff/Respawn/OpenPR callbacks + schema v3 [speculative branch farm] (#273) (df7bf36)

## [2.20.0] - 2026-05-18

### Added
- show effective cwd in the persistent bottom status line (0a2a46d)

## [2.19.1] - 2026-05-18

### Fixed
- bust waitlist-count cache on insert + lower JS cache TTL (91836ee)

### Changed
- added .vercel to .gitignore (dd50366)

## [2.19.0] - 2026-05-18

### Added
- seedBuffer fast-path with echo + repl-loop test coverage (PR #271 review feedback) (37cfaa6)
- auto-rename worktrees from first user message via haiku (55600c9)

### Fixed
- C1 provider.setCwd() proxy + H2 live AgentSession T19 + M4/M8 residuals (6da5d9a)
- emit console.warn when no text blocks returned (T21b) (7c9bf00)
- correctness fixes C1/CA2/C3/C4 from PR #271 review (6fca5c5)

### Changed
- add coverage for T1/T10/T13/T15/T19/T21+T22 from PR #271 review (ed89c62)
- fire first-turn hook concurrently with runTurn (P1) (7a8fe23)

## [2.18.0] - 2026-05-18

### Added
- swap waitlist storage from Supabase to Neon (9e7ca44)

## [2.17.0] - 2026-05-18

### Added
- subagent permission system + worktree isolation (#242) (1ffaeb7)

## [2.16.0] - 2026-05-18

### Added
- waitlist signup via Supabase with live count in hero (3e2a003)

### Fixed
- thread session cwd through all tool handlers and surfaces (519991b)

## [2.15.1] - 2026-05-18

### Fixed
- move subagent narration below tool children (0704363)

## [2.15.0] - 2026-05-18

### Added
- route subagent done-blocks above prose when emitted pre-markdown (89d2d47)

### Changed
- assert agentType propagates from SubagentExecutor to renderer (7e94a0a)

## [2.14.4] - 2026-05-18

### Fixed
- resolve /review findings on PR #275 (a187db5)

## [2.14.3] - 2026-05-18

### Fixed
- address PR #278 review feedback — banner, --pin, robustness (e7f148f)

### Changed
- add coverage for update command, fetchLatestVersion, and banner ordering (e33da04)

## [2.14.2] - 2026-05-18

### Fixed
- prevent heredoc newlines from corrupting tree connector rendering (76d719e)

## [2.14.1] - 2026-05-18

### Fixed
- show update banner on startup and add `afk update` command (c4e48da)

## [2.14.0] - 2026-05-18

### Added
- implement form-mode field-by-field REPL handler (330e043)

### Fixed
- collapse redundant Agent row by merging label into parent entry (4b5ea2e)

## [2.13.1] - 2026-05-17

### Fixed
- surface truncation as warning + spill full output to disk (2892755)

### Changed
- extract ReplRenderer output seam; route mid-turn writes through compositor (#272) (e51ec5d)

## [2.13.0] - 2026-05-17

### Added
- persist tool events in session archives (#268) (3f73a32)

## [2.12.1] - 2026-05-17

### Fixed
- summarize memory tool JSON in tool-lane outcomes (af5cda2)

## [2.12.0] - 2026-05-17

### Added
- centralized user-facing error handling (0943e9f)

## [2.11.0] - 2026-05-17

### Added
- witness layer — durable trace evidence for AFK sessions (#270) (76bf752)
- readline keybindings — history ring, /keys reference (8ea7f1d)
- friendly usage-limit UX + auto-resume + account hot-swap (e187421)
- render slash commands in brand orange in agent output (1936150)
- add daily sweep automation for stale and empty worktrees (99cfd38)
- closure ritual on /plan off — defer flip until model emits the plan (a847049)
- per-turn system-prompt addendum when permissionMode === 'plan' (52ec054)
- plan mode as honest safety primitive — Shift+Tab / /plan toggle with hook-level refusal (bd15a7c)
- tool-lane rendering fixes — outcome nouns, bash cd-prefix, dispatch-children cap, fence-detection (#232) (1789348)
- pop flag dropdown on space after slash command (fa37ba8)
- add /telegram-setup skill with secret-isolated config helpers (8fe0369)
- export AGENT_SURFACE=afk at startup (4ebc9a3)

### Fixed
- resolve 11 of 12 deferred review findings (second pass) (6c1da05)
- resolve 13 review findings on readline-keybindings PR (a11a217)
- incremental subagent scrollback commit + per-source flush (0270d10)
- filter incomplete thinking blocks before API round-trip (79e050d)
- UX audit — state-first copy, force-exit distinction, Shift+Tab pending fix (33a1318)
- suppress subagent prose on TTY; route to transient thinking tail (#256) (255fc39)
- clear abortController on suspended-yield and pendingAbort early-return (9aa31b0)
- wire subagent sink for Telegram; emit thinking summary on non-TTY (ffb0cf7)

### Changed
- unify raw chalk usages and fix bullet/heading semantics (83c8a4e)
- Print resume command on interactive exit (8d8e039)
- correct ambiguous 'SDK' wording in plan-mode comments (0bceaa5)
- Audit/resolve findings c1 c10 (#233) (c59ed1c)
- project headings and lists in card-line renderer (5dbf1e8)
- project headings and lists in card-line renderer (8e93fbb)
- document pre-split archive directory (647d432)

### Fixed
- tool-lane no longer leaks raw memory-tool JSON when results exceed the 80-char single-line truncation cap

## [2.9.1] - 2026-05-16

### Fixed
- address review feedback on PR #250 (d5e5fe9)
- postinstall works on fresh worktree; mask bot-token input in setup wizard (898b330)
- propagate agentType at raw agent dispatch site (Bug #2) (f04b5f5)
- clamp tree-child lines to terminal width (12e23e3)

### Changed
- bounded stalled lifecycle; replace checkPauseAnnotations (Bug #3) (929a350)
- unify tool-use counter; isolate progress-event field (Bug #4) (412610e)
- extract declarative assignConnectors; fix Bug #5 overflow connector (715d81e)
- introduce CommitCoordinator; serialize scrollback writes; apply committing guard (1832a37)
- Phase 1 failing tests — rendering bugs #1–#5 + snapshot pins (RED) (cc354bb)
- Phase 2 rendering refactor — amended spec (post /devils-advocate) (7bfb89c)
- Phase 0 reconnaissance — handoff brief + architecture docs (ad2c3d9)

## [2.9.0] - 2026-05-16

### Added
- max_tool_calls_per_node budget via chained progressSink (ad07780)
- per-node max-runtime timeout with honest abort propagation (406c93d)
- preserve partial assistant content on failure path (36acee4)

### Fixed
- resolve three PR review issues — TDZ guard, type leak, clamp warning (4127d11)

## [2.8.1] - 2026-05-16

### Fixed
- wire child provider into forked skill children (0749128)

### Changed
- Merge pull request #209 from griffinwork40/fix/skill-executor-child-provider (af1126c)

## [2.8.0] - 2026-05-16

### Added
- cascade subagent thinking into parent tool/thinking lanes (f402759)

### Changed
- Merge pull request #221 from griffinwork40/feat/cascade-subagent-thinking-runtime (fcbfba8)
- keep memory tools in READ/WRITE categories (0bdd75a)
- add AFK.md for agent-afk CLI and architecture overview (0d840ad)
- Merge pull request #240 from griffinwork40/claude/subagent-thinking-merge-pr-wvXy6 (c79c33b)
- Merge branch 'main' into feat/cascade-subagent-thinking-runtime (4edc107)

## [2.7.1] - 2026-05-15

### Fixed
- drop data-reveal from outer changelog section (5f793dc)
- commit generated changelog.html so /changelog renders (ed45256)

### Changed
- drop unreleased section and per-release link buttons (ab5533f)
- reposition around the pressure path + add founder pricing (5ded07a)
- remove stray .afk-work worktree gitlinks (60422fb)
- rewrite src/agent/README, drop IMPLEMENTATION.md, prune SDK refs (1e34874)
- fix stale @anthropic-ai/claude-agent-sdk references (824ef5e)

## [2.7.0] - 2026-05-15

### Added
- group same-tool siblings + categorical overflow + bash summarizer (ba43dda)

## [2.6.4] - 2026-05-15

### Fixed
- address review findings on thinking-render-bugs (547cb78)
- surface thinking content during turns (232697f)

## [2.6.3] - 2026-05-15

### Fixed
- anchor fence detection to line start (fc5654d)

## [2.6.2] - 2026-05-15

### Fixed
- attribute nested subagents and silence stdout debug leak (77e224c)

### Changed
- add telemetry-split orchestration plan (0be9561)

## [2.6.1] - 2026-05-15

### Fixed
- align user-echo card content with inline prompt column (8019e2b)

## [2.6.0] - 2026-05-14

### Added
- expose dispatchSkill callback on SkillExecutionContext (a4515bf)

## [2.5.0] - 2026-05-14

### Added
- badge/ledger/events subsystem with session wiring (1cd0753)

### Fixed
- ledger shallow-copy, stats degraded-ctx message, inconclusive display; add clearRegistryForTesting; /stats tests (6c4bd46)
- emit complete in finally so status bar clears on handler throw; refactor layer inversion (91591fe)

## [2.4.1] - 2026-05-14

### Fixed
- update budget tests to use transformProviderEvent; fix loop translatorErrored to emit turn.completed on abort only (bb420ab)
- restore timeout enforcement, remove unsafe getOutputStream (cb0cdb0)
- remove MessageQueue indirection, fix interrupt crash (d30c95c)

### Changed
- Merge pull request #203 from griffinwork40/worktree-shimmering-spinning-frost (b69dfef)
- resolve conflicts with origin/main — keep PR #203 no-MessageQueue architecture, port budget enforcement (C6) to sync transformProviderEvent (2c90daf)
- Merge branch 'main' into worktree-shimmering-spinning-frost (b6c5da5)

## [2.4.0] - 2026-05-14

### Added
- **C6** `--max-budget-usd` is now enforced: `AgentSession` accumulates `totalCostUsd` from each `turn.completed` event and aborts the internal `AbortController` when the ceiling is crossed. The abort reason surfaces as `"Budget ceiling reached: $X.XXXX >= $Y.YYYY"`.
- **C9** WAL supersede crash window narrowed: `supersedeFact()` now stores `(old_content, old_created_at, new_content, new_created_at)` fingerprints in the supersede WAL entry alongside the legacy `(old_fact_id, new_fact_id)` rowids. `replayWAL()` resolves fingerprints to current rowids first, falling back to raw rowids for pre-fix WAL entries.

### Fixed
- **C5** Telegram `SessionManager.getSession()` race condition: concurrent calls for the same `chatId` now share a single in-flight creation `Promise` via a `pendingSessions` guard, preventing duplicate session spawns.
- **C7** `parseProvider()` in `shared-helpers.ts` now accepts an optional `memoryStore` parameter and threads it into the constructed `AnthropicDirectProvider`, ensuring only one SQLite connection is opened when `--provider anthropic-direct` is passed explicitly. Applied in both `chat.ts` and `interactive/bootstrap.ts`.
- **C8** `runDAG` in `dag.ts` leaked an `AbortSignal` listener on the outer signal when the DAG completed normally. Fixed by using a named handler (`forwardAbort`) removed in a `finally` block. Per-node listeners are also explicitly removed in `finally` after each node completes.

### Security
- **C1** Plugin/marketplace path traversal: validate manifest `name` with `SAFE_PLUGIN_NAME` regex and `assertWithinPluginsDir()` before any `join()`-based directory creation in `src/agent/plugins/install.ts` and `src/agent/marketplaces/install.ts`.
- **C2** `permissionMode` default changed from `'bypassPermissions'` to `'default'` in `session-setup.ts`. Callers that previously relied on the implicit bypass must now pass `permissionMode: 'bypassPermissions'` explicitly in their `AgentConfig`.
- **C3** `write_file` now refuses to write to a built-in denylist of credential/system paths (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gcloud`, `/etc`, `/System`, `/private/etc`, `/usr/local/etc`). Additional paths can be appended via the `AFK_WRITE_DENYLIST` env var (colon-separated absolute paths).
- **C4** `bash` handler now emits a one-time `[security]` warning to stderr when `AFK_PERMISSION_MODE=bypassPermissions`, surfacing the shell-injection risk. Full `execFile` migration is deferred (tracked C4).
- **C10** Scheduler telemetry (`forge-telemetry.jsonl`) now runs `redactInlineSecrets()` over both the `command` and `responseExcerpt` fields before writing. `INLINE_SECRET_PATTERNS` extended to cover OpenAI `sk-*` keys, Telegram bot tokens, and mixed-case `KEY=`/`TOKEN=` patterns.

### Added
- render skill tool children + spinner elapsed time (d4e48b6)
- enforce --max-budget-usd via turn.completed cost accumulation (C6) (8e1a223)

### Fixed
- idempotent supersedeFact on UNIQUE constraint collision (3419306)
- throw BudgetExceededError instead of bare return on budget abort (917f7a9)
- add memory tools to interactive REPL allowlist (0a2b2b0)
- WAL supersede crash window — store content fingerprints instead of raw rowids (C9) (e9f5fde)
- correctness fixes — session-manager race guard, dual MemoryStore, DAG signal leak (C5, C7, C8) (1567f7d)
- fix list newline collapse and card border off-by-one (5d8cf8f)
- show all rawBody lines in asking verdict card fallback (ee9dad8)
- categorize memory_search/memory_update/procedure_write tools (5b3733f)
- prevent schema mismatch on hypothesis synthesis (a9944de)
- wrap blockquote content before prefixing with bar (20b108b)
- add newline wrapping for H3+ headings (1aa9aae)

### Changed
- include parentId in fork assertion (9968994)
- drop stale "atlas" surface variant (305972c)
- add clarifying comments for colon-separator caveat and Telegram permissionMode (6c0ebcf)
- fix symlink test — existsSync guard + AFK_WRITE_DENYLIST symlink case (0c6646e)
- resolve PR #211 review findings — C2/C3/C4/C5/C6/C9 (0945a2d)
- harden plugin paths, permission default, write_file denylist, bash warning, telemetry redaction (C1-C4, C10) (967a285)
- refresh to match v2.3.x architecture (34f094d)
- wire coverage gate into CI + add real loop.ts tests (3166367)
- prune slop tests, enforce coverage floor (4811e64)

## [2.3.1] - 2026-05-14

### Fixed
- repair release pipeline + dev start scripts (c83ede0)

## [2.3.0] - 2026-05-14

### Added
- add /init slash command to scan project and generate AFK.md (af56752)

## [2.2.0] - 2026-05-14

### Added
- nest compose-spawned subagents under the compose tool-lane entry (90bea64)

### Fixed
- resolve review findings on compose subagent nesting (#202) (a627cab)

## [2.1.0] - 2026-05-14

### Added
- background tasks — Ctrl+B detach, /bg, persistent status bar (#196)
- clipboard failure msg, debug logging, dual-probe
- add Ctrl+X to discard clipboard image attachments
- auto-discover project-level AFK.md as system prompt source (#186)

### Fixed
- pass full user input to recordTurn for background tasks
- resolve review findings on background tasks (#200)
- preserve paragraph breaks in stripCommandTags and extractSkillTag (#201)
- move console.log before compositor arm to prevent ghost spinner
- close research-agent contract gap + harden mint invariant

### Changed
- add guidelines for ordered-operation sequences
- add 'Crafted by Griffin Long' footer credit linked to graisol.com

### Added
- background tasks — Ctrl+B detach, /bg, persistent status bar (#196) (0209cb4)
- clipboard failure msg, debug logging, dual-probe (88a3114)
- add Ctrl+X to discard clipboard image attachments (c68e47c)
- auto-discover project-level AFK.md as system prompt source (#186) (4061d7c)

### Fixed
- pass full user input to recordTurn for background tasks (de62c22)
- resolve review findings on background tasks (#200) (0c8fb76)
- preserve paragraph breaks in stripCommandTags and extractSkillTag (#201) (7f7c636)
- move console.log before compositor arm to prevent ghost spinner (af028fc)
- close research-agent contract gap + harden mint invariant (e528568)

### Changed
- bump version to 2.0.0 and update changelog (4395866)
- add guidelines for ordered-operation sequences (70a65b4)
- add 'Crafted by Griffin Long' footer credit linked to graisol.com (26b12c2)

## [1.21.0] - 2026-05-14

### Added
- add afk-worktrees-status.sh read-only inspector (#198) (eaeaaa7)

## [1.20.0] - 2026-05-13

### Added
- add send_telegram built-in tool for operator notifications (#187) (c7150a1)

## [1.19.0] - 2026-05-13

### Added
- surface execution trace from child sessions to parent (#193) (4af131b)

## [1.18.0] - 2026-05-13

### Fixed
- `SubagentExecutor` success path now coerces non-string `message.content` (e.g. SDK
  `ContentBlock[]`) to a string via `JSON.stringify`, so `ToolResult.content` is always
  a valid string. Prevents downstream consumers from receiving an object where a string
  is contracted.

### Added
- push primitive + onTaskComplete callback for daemon (#160) (eea6063)

### Changed
- Feat/orchestration (#188) (1b42c6a)

## [1.17.0] - 2026-05-13

### Added
- add Phase 1 triage, named outcomes, and multi-file routing (#194) (6465414)

### Changed
- Feat/landing changelog page (#190) (7a35bb8)
- Fix/clipboard image paste (#189) (4a21501)

## [1.16.1] - 2026-05-13

### Fixed
- decouple AFK telemetry from ~/.claude/agent-framework (#191) (01160ba)

## [1.16.0] - 2026-05-13

### Added
- repaint stage rail on transitions + enable extended thinking by default (4750263)

## [1.15.2] - 2026-05-13

### Fixed
- add blank line between paragraphs in markdown rendering (c4949d7)

## [1.15.1] - 2026-05-13

### Fixed
- render inline markdown in card bodies (#165) (0d803a6)

## [1.15.0] - 2026-05-13

### Added
- activate compose tool in production entrypoints (#185) (3d93f00)

## [1.14.6] - 2026-05-13

### Fixed
- resume on JSON-string {userApproved:true} from skill-tool boundary (#166) (f7387d3)

## [1.14.5] - 2026-05-13

### Fixed
- truncate /skills descriptions and add detail view (#181) (905edb9)

## [1.14.4] - 2026-05-13

### Fixed
- per-call signal check in executeBatch parallel branch (#182) (4c87ee7)

## [1.14.3] - 2026-05-13

### Fixed
- repair clipboard image paste on macOS (Cmd+V + binary readback) (#163) (7b6e0d7)

## [1.14.2] - 2026-05-13

### Fixed
- normalize paragraph spacing and fix overlay alignment (#184) (7cc3752)

## [1.14.1] - 2026-05-13

### Fixed
- restore cursor, honest spinner, durable interrupt notice, honest --stream (#183) (e50c1ba)

## [1.14.0] - 2026-05-13

### Added
- add compose tool for DAG-based parallel subagent orchestration (#173) (a78027f)

## [1.13.4] - 2026-05-13

### Fixed
- use dirname on fileURLToPath before joining relative paths (1251a74)

## [1.13.3] - 2026-05-13

### Fixed
- auto-submit queued messages instead of requiring a second Enter (92a1c83)

## [1.13.2] - 2026-05-13

### Fixed
- update description for clarity and improve commit process guidance (e986f1c)

## [1.13.1] - 2026-05-13

### Fixed
- add memory tools to allowlist and prevent dangling tool_use on abort (6162b2c)

## [1.13.0] - 2026-05-13

### Added
- add completion glyphs to tool result display (8d0d756)

## [1.12.0] - 2026-05-13

### Added
- add auto-update checker with notify/auto/off policy (bbc9ae5)

## [1.11.0] - 2026-05-13

### Added
- improve subagent visibility in nested skill runs (eed3ba6)

## [1.10.4] - 2026-05-13

### Fixed
- convert skill-name XML tags to styled badges and fix tool glyph casing (b754e41)

## [1.10.3] - 2026-05-13

### Fixed
- eliminate streaming line duplication and table garbling (ca6a204)

### Changed
- broaden skill to accept PR numbers, SHAs, branches, and patch files (246824c)

## [1.10.2] - 2026-05-13

### Fixed
- correct skill count, add email fallback, ship OG image (640521a)

## [1.10.1] - 2026-05-13

### Fixed
- add blank line between user input and agent response (44107d6)

## [1.10.0] - 2026-05-12

### Added
- highlight slash commands anywhere in the input buffer (d5e570c)

## [1.9.0] - 2026-05-12

### Added
- add system prompt instructions for cross-session memory tools (1421e8e)

### Changed
- bump version to 1.8.1 (7bfa67a)
- update CLI entry points to use .mjs extension for improved module compatibility (678ce17)
- consolidate duplicated 1.8.0 Added subhead (88be7f3)

## [1.8.0] - 2026-05-12

### Added
- Telegram bot integration: `afk telegram {start|stop|status|restart|logs|setup}` CLI subcommands (#154) (f2eb50d)
- User-scope config at `~/.afk/config/afk.env` — Telegram tokens and allowlist stored outside the project tree
- `afk telegram setup` interactive wizard with keychain/file/env token storage options
- File-authoritative override for Telegram config keys: `~/.afk/config/afk.env` wins over shell env for `TELEGRAM_BOT_TOKEN`, `AFK_TELEGRAM_ALLOWED_CHAT_IDS`, `TELEGRAM_VERBOSE`, `TELEGRAM_DATA_DIR`
- Bot identity validation at startup via `getMe` before handing token to Telegraf

### Fixed
- Shell-shadowed bot token: file value now overrides stale shell exports for Telegram-specific keys (inverse of dotenv precedence, intentional for operator-managed config)

## [1.7.0] - 2026-05-12

### Added
- cross-session memory system + mint state persistence (#115) (40231c6)

## [1.6.0] - 2026-05-12

### Added
- add --dump-prompt debug flag for SDK prompt verification (#34) (c49fb7d)

## [1.5.1] - 2026-05-12

### Fixed
- show early tool-use indicator during model generation (#123) (0b91592)

## [1.5.0] - 2026-05-12

### Added
- add /changelog page rendered from CHANGELOG.md (#158) (90f413c)

### Fixed
- improve terminal rendering spacing and wrapping (#156) (72adfa7)
- include bundled plugins in system prompt manifest (#153) (7d64db8)

## [1.4.0] - 2026-05-12

### Changed
- Enhance routing telemetry with detailed event structure and telemetry emission
- phase 1 orchestration pressure — frame main session as coordinator

### Added
- surface parallelize-dispatch failures via discriminated union (#152) (47caa39)

### Fixed
- handle drainQueue rejection in processOne finally (5bc2690)
- preserve slash command highlighting after submission (3afa120)

### Changed
- add orchestration pressure audit (d0a03a3)

## [1.3.1] - 2026-05-12

### Fixed
- reset context bar on /clear (1b5f637)
- flush tool lane to scrollback on subagent done (ab8dea6)

### Changed
- address review feedback from #151 review (3395c33)
- co-locate unit tests with the files they exercise (56a6d36)
- add colocate-tests migration helper (3dfd2aa)

## [1.3.0] - 2026-05-11

### Added
- runtime positioning + reversibility-aware autonomy section (1a3af3f)

### Fixed
- correct overclaims, restore working CTA (639790d)

## [1.2.1] - 2026-05-11

### Added
- add /changelog command to generate release entries from git log
- bundle orchestration skills into the binary
- auto-refresh OAuth token on 401 instead of crashing
- implement word and line deletion commands
- make AFK's execution shape legible — verdict cards, stage rail, ledger
- add failure geometry to SALVAGE rework prompt

### Fixed
- stream subagent content in real time during skill execution — replaces line-buffered rendering with `StreamingMarkdownRenderer` so users see live markdown output instead of a spinner
- harden /changelog flag parsing and improve test mocks
- resolve review findings in /changelog command
- add 401 retry integration tests and deduplicate concurrent refreshes
- persist assistant turns in message history

### Changed
- unify feedback on spinner, kill thinking indicator
- add Failure Geometry documentation to outline agent workflow design patterns
- centralize last hardcoded ~/.claude/ path in audit-fit
- centralize path resolution on AFK_HOME, fix surface tags
- opt actions into Node.js 24 (FORCE_JAVASCRIPT_ACTIONS_TO_NODE24)

### Fixed
- restore plain bullets in /changelog (PR #145 H-1) (3432991)
- resolve PR #145 review blockers (e1acf82)
- resolve review blockers — dedup, atomic writes, correct dist path (4cd81b2)
- strip command breadcrumb XML tags from rendered output (#142) (a0812a6)
- add spacing around tool-lane flush in stream renderer (1bbd7a9)
- recognize informal approval patterns in parseMintInput (e9f8a60)
- correct inflated context-% meter on anthropic-direct (#143) (aff2475)

### Changed
- extract shared utils + add auto-release CI (328ae85)

## [0.2.4] - 2026-05-10

### Added
- `~/.afk/` config home — CLI, Telegram, and daemon resolve user-scope state there, decoupling AFK from `~/.claude/`
- Plugin auto-discovery (`~/.afk/plugins/`) and `afk plugin {install|update|list|remove|enable|disable}` CLI (git-based MVP, no marketplace)
- 1M-context model variants (`opus_1m`, `sonnet_1m`)
- Bracketed-paste input box with atomic multi-line paste handling
- Terminal resize reflow — width-aware boxes, dividers, status line, todo panel, streaming markdown commit wrap (`ResizeBus` + `wrap-ansi`)
- Plugin-skill SDK bridge — `/skills`, `/reload-plugins`, `/agents` via passthrough handlers; replaces the bespoke `skill-bridge.ts` stubs
- Beautiful-TUI: live progress lane, context-pane (todo surface above prompt with structural-fingerprint dedupe), shared `InputCore` powering compositor + input-box, palette `heading`/`label` semantic roles, width-aware debug banner
- Provider abstraction (`src/agent/providers/{anthropic,openai-codex}.ts`) — model family selects the runtime backend via `providerForModel()`
- `AbortGraph` — transitive parent→child cancellation across subagent trees
- `withTimeout` / `TimeoutError` helpers
- Zod `outputSchema` on `SubagentResult<T>` and `ForkSubagentOptions` — extraction + parsing in `src/agent/subagent/{handle,result}.ts`
- Hooks infrastructure — SessionStart/End, SubagentStart/Stop, PreToolUse/PostToolUse with `decision: 'block'` short-circuit
- `--model` pass-through for non-Anthropic routes — `auto`, full SDK IDs, and codex models flow through to the SDK untouched
- SDK dependency tracking — `pnpm audit:sdk` snapshot + `.sdk-dependency.lock.json` allowlist + CI gate via `pnpm audit:sdk:check`

### Fixed
- `StreamEvent` schema — `delta.type` made optional to tolerate `message_delta` events (was hard-failing every successful turn)
- `/clear` rebuilds the SDK session instead of forwarding a string
- `listSessions` skips SDK PID-registry sidecars; `/resume` formatter guards NaN / undefined timestamps
- CLI: tool names and file paths now surface in interactive output

### Changed
- All AFK state lives under `~/.afk/`, never `~/.claude/`
- Project is pnpm-only — `npm install` will desync the lockfile

## [0.1.0] - 2026-02-09

### Added
- Initial release
- Project infrastructure
- Testing framework
- Basic CLI commands

[Unreleased]: https://github.com/griffinwork40/agent-afk/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/griffinwork40/agent-afk/releases/tag/v0.1.0
