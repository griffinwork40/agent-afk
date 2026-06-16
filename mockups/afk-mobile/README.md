# AFK Mobile — agent mission control (SwiftUI mockup)

A code-first, IDE-flavored mobile client for monitoring and steering autonomous
agent sessions while you're AFK. The organizing idea: **the sidebar groups sessions
by the slash command that spawned them** (a `/diagnose` group, a `/review` group, a
`/mint` group, …) — each session named by what it's doing — and tapping one opens a
**chat ⇄ IDE-hybrid** transcript.

This is an interactive, mock-data-driven mockup — no networking, auth, or persistence.

## Screenshots

Rendered on the iOS 26.4 simulator (iPhone 17 Pro + iPad Pro 13"):

- `shots/afk-mobile-iphone-sidebar.png` — **iPhone**: the grouped-by-slash-command session
  list (the headline idea) full-width, with the `All / Running / Needs you` filter.
- `shots/afk-mobile-iphone-detail.png` — **iPhone**: a session in `asking` state — the
  elicitation composer ("answer from your phone") with single-line answer chips.
- `shots/afk-mobile-ipad-asking.png` — **iPad** (both columns): grouped sidebar + the asking
  session's transcript + elicitation composer.
- `shots/afk-mobile-ipad-running.png` — **iPad** (both columns): a live `/diagnose` session
  with a collapsible tool call and a 3-subagent fan-out (live progress + turn counts).

### Demo launch overrides (Simulator)

The app reads optional launch env vars (also genuine deep-link/state affordances):

- `AFK_DEFAULT=none|running|asking|blocked|done|interrupted` — initial session selection
  (`none` opens on the fleet list, ideal for the iPhone sidebar shot).
- `AFK_COMPACT=detail` — on iPhone, deep-link straight into the selected session's detail.
- `AFK_COLS=all` — keep the sidebar pinned beside the detail (both columns) on iPad portrait.

```bash
SIMCTL_CHILD_AFK_DEFAULT=asking xcrun simctl launch --terminate-running-process booted com.afk.mobile.AFKMobile
```

## Run it

It's a Swift Playgrounds App package (`.swiftpm`):

- **Xcode 26+:** open `AFKMobile.swiftpm`, pick an iPhone/iPad simulator, Run.
- **Swift Playgrounds (Mac/iPad):** open `AFKMobile.swiftpm` and tap Run.
- Or open any view file and use the **Xcode canvas `#Preview`** (every view has one).

Deployment target is **iOS 26.0** (the Liquid Glass design system). `swift build`
from the CLI won't work — the App package uses `AppleProductTypes`, which only
resolves inside Xcode / Swift Playgrounds.

## Type-check (the build gate, no simulator needed)

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcrun --sdk iphonesimulator swiftc -typecheck -swift-version 5 \
  -target arm64-apple-ios26.0-simulator \
  $(find AFKMobile.swiftpm -name '*.swift' ! -name 'Package.swift')
```

## What it demonstrates

- **Grouped sidebar** — collapsible per-command sections, live status dots, "needs you"
  filter (Asking + Blocked), search, and a glass `+` that opens a slash-command palette.
- **Adaptive navigation** — `NavigationSplitView`: floating glass sidebar on iPad,
  auto-collapse to a push stack on iPhone.
- **Liquid Glass discipline** — glass only on the navigation layer (sidebar, status
  header, composer, filter, FAB, jump-to-latest); content surfaces stay solid.
- **Transcript renderer** — user / agent (markdown) / streaming tokens / reasoning /
  collapsible tool calls / unified diffs / sub-agent tree / compose-DAG pipeline /
  skill panel / usage-limit pause / terminal-state banner.
- **Answer from your phone** — when a session is `asking`, the composer becomes the
  matching elicitation control (confirm / choice / multi / number / text).

## Faithfulness to AFK

The data model mirrors real agent-afk runtime types so the UI surfaces actual
concepts, not invented ones:

| UI model | AFK source |
|---|---|
| `TerminalState` (Done/Blocked/Asking/Interrupted + exact field labels) | `src/cli/commands/interactive/terminal-state.ts:44` |
| `MessageKind` (text, thinking, toolCall, toolDiff, …) | `src/agent/session/stream-consumer.ts` |
| `SubagentRef` (status, completion, turns) | `src/agent/subagent/result.ts:61` |
| `ComposeNode` (DAG outputs/failed/skipped) | `src/agent/dag.ts:50` |
| `Elicitation` (text/confirm/choice/multi/number) | `src/agent/types/sdk-types.ts:192` |
| `Surface` (cli/repl/daemon/telegram) | `src/agent/awareness/types.ts:36` |

## Layout

```
AFKMobile.swiftpm/
  Package.swift            # .iOSApplication, iOS 26 floor
  App.swift                # @main
  Theme/Theme.swift        # AFK palette, mono fonts, radii
  Models/                  # Session · Message · Elicitation · AppModel · MockData
  Views/
    RootView.swift         # NavigationSplitView
    Sidebar.swift          # grouped sidebar + command palette
    SessionDetail.swift    # transcript shell + status header
    MessageViews.swift     # all message-kind renderers
    Composer.swift         # composer + elicitation composer
    Components.swift       # status badge, chips, sparkline, filter, markdown, streaming
```

> Standalone artifact under `mockups/`. Not wired into the pnpm/tsc/vitest build.
