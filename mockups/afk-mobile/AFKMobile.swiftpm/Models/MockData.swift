import SwiftUI

// An authentic AFK story across five slash commands, exercising every message kind
// and every status. Drives the entire interactive mockup.
enum MockData {
    static var sessions: [Session] {
        [diagnoseS1, diagnoseS2, diagnoseS3, reviewS1, mintS1, mintS2, refactorS1, shipS1]
    }

    // MARK: /diagnose

    static let diagnoseS1 = Session(
        id: "diagnose-7f31c2a9", command: .diagnose,
        title: "flaky vitest race in stream-consumer",
        status: .done, model: "sonnet", surface: .repl,
        elapsed: "6m", turns: 11, tokens: 48_200,
        tokenSeries: [2, 5, 4, 8, 12, 9, 15, 22, 30, 41, 48],
        messages: [
            Message(kind: .user("the stream-consumer test is flaky — fails ~1 in 5 runs locally. find the root cause and fix it.")),
            Message(kind: .agentText("On it. Reproducing first, then isolating the race.")),
            Message(kind: .toolCall(ToolCall(
                name: "bash", arg: "vitest --run stream-consumer.test.ts --repeat 20",
                input: "pnpm test -- src/agent/session/stream-consumer.test.ts --repeat 20",
                output: "✓ 19 passed\n✗ 1 failed — \"flushes buffer on retry\"\n  expected 3 chunks, received 2",
                status: .ok, durationMs: 8_420))),
            Message(kind: .thinking("Two chunks instead of three on the failing run → the retry path discards the in-flight buffer before the final flush. The flush and the retry-reset aren't ordered. Classic event-loop boundary race.")),
            Message(kind: .toolCall(ToolCall(
                name: "grep", arg: "stream.retry handler",
                input: "grep -n \"stream.retry\" src/agent/session/stream-consumer.ts",
                output: "118: case 'stream.retry':\n119:   this.buffer = []   // reset BEFORE pending flush resolves",
                status: .ok, durationMs: 240))),
            Message(kind: .toolDiff(FileDiff(path: "src/agent/session/stream-consumer.ts", lines: [
                DiffLine(kind: .context, oldNum: 117, newNum: 117, text: "case 'stream.retry': {"),
                DiffLine(kind: .remove, oldNum: 118, newNum: nil, text: "  this.buffer = [];"),
                DiffLine(kind: .remove, oldNum: 119, newNum: nil, text: "  this.emit('flush');"),
                DiffLine(kind: .add, oldNum: nil, newNum: 118, text: "  await this.flush();   // drain before reset"),
                DiffLine(kind: .add, oldNum: nil, newNum: 119, text: "  this.buffer = [];"),
                DiffLine(kind: .context, oldNum: 120, newNum: 120, text: "  break;"),
            ]))),
            Message(kind: .toolCall(ToolCall(
                name: "bash", arg: "vitest --run --repeat 40",
                input: "pnpm test -- src/agent/session/stream-consumer.test.ts --repeat 40",
                output: "✓ 40 passed (0 failed)\nDuration 11.2s",
                status: .ok, durationMs: 11_210))),
            Message(kind: .terminal(TerminalState(kind: .done, fields: [
                TerminalField(label: "What was done", value: "Ordered the buffer flush before the retry reset in stream-consumer.ts; the race that dropped the final chunk is gone."),
                TerminalField(label: "Evidence", value: "40/40 repeat runs pass (was ~1-in-5 fail). Diff: +2 / −2."),
                TerminalField(label: "Deferred", value: "None. A regression test for the retry path could be added later."),
            ]))),
        ], pendingElicitation: nil)

    static let diagnoseS2 = Session(
        id: "diagnose-b8e0d144", command: .diagnose,
        title: "abort-graph leak on subagent stop",
        status: .running, model: "opus", surface: .repl,
        elapsed: "2m", turns: 5, tokens: 21_800,
        tokenSeries: [1, 3, 6, 4, 9, 11, 14, 18, 21],
        messages: [
            Message(kind: .user("subagent controllers aren't being released after SubagentStop — heap grows over a long session. dig in.")),
            Message(kind: .agentText("Reproducing the leak and fanning out three readers across the abort graph, the subagent manager, and the hook teardown path.")),
            Message(kind: .toolCall(ToolCall(
                name: "bash", arg: "node --expose-gc scripts/leak-probe.mjs",
                input: "node --expose-gc scripts/leak-probe.mjs --sessions 200",
                output: "running…", status: .running))),
            Message(kind: .subagents([
                SubagentRef(label: "abort-graph-reader", status: .succeeded, completion: 1.0, turns: 6,
                            summary: "child controllers retained in parent.children map after stop"),
                SubagentRef(label: "subagent-manager-reader", status: .running, completion: 0.55, turns: 4,
                            summary: "tracing dispose() call sites"),
                SubagentRef(label: "hook-teardown-reader", status: .running, completion: 0.30, turns: 2,
                            summary: "checking SubagentStop cleanup"),
            ])),
            Message(kind: .agentStreaming("Early signal: `AbortGraph.detach(childId)` is never called from the SubagentStop path, so the parent keeps a strong reference to each finished child's controller. Confirming against the manager before I propose the fix")),
        ], pendingElicitation: nil)

    static let diagnoseS3 = Session(
        id: "diagnose-3c7a9f02", command: .diagnose,
        title: "retry policy for transient 529s",
        status: .asking, model: "sonnet", surface: .repl,
        elapsed: "4m", turns: 7, tokens: 33_100,
        tokenSeries: [3, 6, 9, 14, 19, 24, 28, 33],
        messages: [
            Message(kind: .user("requests intermittently 529. add a retry but I'm not sure what backoff we want.")),
            Message(kind: .agentText("I traced the 529s to the provider stream init. A bounded exponential backoff is the safe default, but the **policy** is a product call — it changes worst-case latency. Surfacing the choice.")),
            Message(kind: .toolCall(ToolCall(
                name: "read_file", arg: "providers/anthropic-direct/query.ts",
                input: "read_file src/agent/providers/anthropic-direct/query.ts:270-300",
                output: "281: const sessionId = event.session_id;\n// no retry wrapper around the stream init",
                status: .ok, durationMs: 120))),
        ],
        pendingElicitation: Elicitation(
            type: .choice,
            message: "Which retry policy for transient 529s?",
            context: "Affects worst-case latency. Honors Retry-After in all options.",
            choices: ["Exp ×3", "Exp ×5", "Linear ×3", "No retry"],
            allowSkip: true, allowCustom: true,
            assumption: "Exponential backoff, 3 attempts, honoring Retry-After.",
            followup: "Wire the chosen policy into query.ts + a unit test asserting the backoff schedule."))

    // MARK: /review

    static let reviewS1 = Session(
        id: "review-a1209ee7", command: .review,
        title: "PR #796 — go tool-parse fix",
        status: .blocked, model: "sonnet", surface: .repl,
        elapsed: "1m", turns: 3, tokens: 9_400,
        tokenSeries: [2, 4, 6, 7, 9],
        messages: [
            Message(kind: .user("/review https://github.com/griffinwork40/agent-afk/pull/796")),
            Message(kind: .agentText("Fetching the PR diff to run the review dimensions (security, correctness, api-compat, tests).")),
            Message(kind: .toolCall(ToolCall(
                name: "bash", arg: "gh pr view 796 --json files",
                input: "gh pr view 796 --repo griffinwork40/agent-afk --json files,additions",
                output: "error: gh auth required — HTTP 401\nThe value of the GH_TOKEN environment variable is not set.",
                status: .error, durationMs: 1_180))),
            Message(kind: .terminal(TerminalState(kind: .blocked, fields: [
                TerminalField(label: "What blocks", value: "Can't fetch PR #796 — `gh` is unauthenticated (HTTP 401) and no GH_TOKEN is set in this environment."),
                TerminalField(label: "To unblock", value: "Provide a GH_TOKEN with repo:read scope, or run `gh auth login` in the session environment."),
                TerminalField(label: "Already done", value: "Review dimensions are queued; they'll run automatically the moment the diff is reachable."),
            ]))),
        ], pendingElicitation: nil)

    // MARK: /mint

    static let mintS1 = Session(
        id: "mint-44c1b8de", command: .mint,
        title: "Telegram weekly digest",
        status: .running, model: "opus", surface: .repl,
        elapsed: "9m", turns: 14, tokens: 71_500,
        tokenSeries: [4, 9, 16, 22, 30, 38, 45, 52, 60, 66, 71],
        messages: [
            Message(kind: .user("/mint a weekly digest that DMs me a Telegram summary of all sessions every Friday")),
            Message(kind: .panel(Panel(
                title: "Spec — Telegram weekly digest", badge: "approved",
                lines: [
                    "Trigger: cron `0 17 * * 5` via the daemon scheduler",
                    "Source: ~/.afk/state/sessions/*/events.jsonl rollup",
                    "Sink: existing Telegram bot, primary chat id",
                    "Out of scope: per-session opt-out (v2)",
                ]))),
            Message(kind: .compose([
                ComposeNode(id: "research", status: .done, label: "research"),
                ComposeNode(id: "implement", status: .running, label: "implement"),
                ComposeNode(id: "verify", status: .pending, label: "verify"),
            ])),
            Message(kind: .agentStreaming("research node landed the rollup shape. Now writing the digest formatter and the scheduler registration; verify node will run the vitest gate once implement completes")),
        ], pendingElicitation: nil)

    static let mintS2 = Session(
        id: "mint-9a02f6b1", command: .mint,
        title: "MCP server health panel",
        status: .interrupted, model: "sonnet", surface: .repl,
        elapsed: "3m", turns: 6, tokens: 19_900,
        tokenSeries: [3, 7, 11, 14, 17, 19],
        messages: [
            Message(kind: .user("/mint a /mcp health panel showing per-server latency")),
            Message(kind: .agentText("Spec drafted — paused at the approval gate before writing any code, per the mint flow.")),
            Message(kind: .terminal(TerminalState(kind: .interrupted, fields: [
                TerminalField(label: "What was in progress", value: "Spec phase complete; awaiting your approval before implementation begins."),
                TerminalField(label: "State saved", value: "Spec persisted to ~/.afk/state/sessions/mint-9a02f6b1/spec.md."),
                TerminalField(label: "Resume requires", value: "Reply `approved` (or edit the spec) to run phases 2–8."),
            ]))),
        ], pendingElicitation: nil)

    // MARK: /refactor

    static let refactorS1 = Session(
        id: "refactor-2d55c70a", command: .refactor,
        title: "rename providerForModel → resolveProvider",
        status: .done, model: "sonnet", surface: .repl,
        elapsed: "5m", turns: 9, tokens: 40_300,
        tokenSeries: [5, 11, 18, 24, 29, 33, 37, 40],
        messages: [
            Message(kind: .user("/refactor rename providerForModel to resolveProvider across the codebase")),
            Message(kind: .agentText("Enumerated 12 call sites across 7 files, grouped into 2 dependency layers, applied per-layer with worktree isolation, verified after each layer.")),
            Message(kind: .toolDiff(FileDiff(path: "src/agent/providers/index.ts", lines: [
                DiffLine(kind: .remove, oldNum: 22, newNum: nil, text: "export function providerForModel(model: string): ModelProvider {"),
                DiffLine(kind: .add, oldNum: nil, newNum: 22, text: "export function resolveProvider(model: string): ModelProvider {"),
                DiffLine(kind: .context, oldNum: 23, newNum: 23, text: "  const id = normalizeModelId(model);"),
            ]))),
            Message(kind: .toolDiff(FileDiff(path: "src/agent/session.ts", lines: [
                DiffLine(kind: .remove, oldNum: 88, newNum: nil, text: "this.provider = providerForModel(opts.model);"),
                DiffLine(kind: .add, oldNum: nil, newNum: 88, text: "this.provider = resolveProvider(opts.model);"),
            ]))),
            Message(kind: .terminal(TerminalState(kind: .done, fields: [
                TerminalField(label: "What was done", value: "Renamed providerForModel → resolveProvider at all 12 sites; updated the SDK-dependency note."),
                TerminalField(label: "Evidence", value: "pnpm lint + pnpm test green at each layer boundary. 7 files, +12 / −12."),
                TerminalField(label: "Deferred", value: "None."),
            ]))),
        ], pendingElicitation: nil)

    // MARK: /ship (headless daemon surface)

    static let shipS1 = Session(
        id: "ship-c0ffee21", command: .ship,
        title: "release v4.5.0",
        status: .running, model: "sonnet", surface: .daemon,
        elapsed: "12m", turns: 8, tokens: 58_000,
        tokenSeries: [6, 12, 20, 28, 35, 44, 51, 58],
        messages: [
            Message(kind: .user("/ship — cut v4.5.0, run gates, open the PR")),
            Message(kind: .agentText("Running the release pipeline headless: ground-state pre-flight → full test suite → commit → push → PR.")),
            Message(kind: .toolCall(ToolCall(
                name: "bash", arg: "pnpm test",
                input: "pnpm test",
                output: "running 1,284 tests…", status: .running))),
            Message(kind: .paused(resetsAt: "3:14pm", autoResume: true)),
        ], pendingElicitation: nil)
}
