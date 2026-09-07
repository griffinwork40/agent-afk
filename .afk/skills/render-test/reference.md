# agent-afk — Renderable Output Reference

The verified element map behind the `/render-test` skill. Everything afk can render after
you send a prompt, split into two classes, with file:line citations into the codebase.
All claims were cross-checked against source and shadow-verified.

---

## Two classes of renderable output

**Class A — markdown the model writes.** A prompt produces these directly. Converted by
`src/cli/formatter.ts` (REPL, marked `Lexer` → ANSI) and `src/telegram/formatter.ts`
(Telegram, → HTML).

**Class B — runtime overlays.** Not markdown — the runtime draws them based on what the
agent *does* (calls a tool, edits a file, thinks, asks, errors, ends the turn). A prompt
triggers them only by making the agent take that action.

**Surface matters:** tables / lists / blockquotes / rules render richly in the REPL but
arrive as *raw markdown text* on Telegram; strikethrough is the reverse (literal in the
REPL, styled `<s>` on Telegram).

---

## Class A — markdown elements

| Element | REPL | Telegram | REPL cite |
|---|---|---|---|
| H1 / H2 / H3+ headings | colored/bold tiers | flattened to plain text | `formatter.ts:136,150-152` · tg `:153` |
| Bold / italic | styled | `<b>` / `<i>` | `:197,201` (inline `:36,40`) · tg `:127-138` |
| Inline code | styled (slash-cmds → brand) | `<code>` | `:193` (inline `:32`) · tg `:120-122` |
| Fenced code block | syntax-highlighted (`emphasize`/highlight.js), `│` gutter | `<pre>` | `:162-191`, `syntax-highlight.ts:15` · tg `:113` |
| Table (GFM) | full box-drawing, aligned | **raw text** (not converted) | `:322-504` |
| Bullet / numbered / nested lists | `•`, respects start index | **raw text** | `:212-292` |
| Task list `[x]`/`[ ]` | ☑ / ☐ glyphs | **raw text** | `:235-246` |
| Blockquote | `│` dim prefix | **raw text** | `:304-320` |
| Link | `text (href)` | `<a href>` | `:46-53` · tg `:146-150` |
| Horizontal rule | `─` to width | **raw text** | `:296-302` |
| Strikethrough `~~` | **raw text** (not styled) | `<s>` | default `:60`/`:507` · tg `:141` |
| Image `![]()` | **raw text** | **raw text** | default `:60`/`:507` |
| HTML escaping | — | `& < >` → entities | tg `:90-93` |

`~~text~~` and `![alt](url)` tokenize as `del`/`image` (marked GFM defaults) but have no case
in either `renderTokens` or `renderInlineTokens`, so both hit `default: return token.raw`.

---

## Class B — runtime overlays (REPL)

| Overlay | Trigger | Cite |
|---|---|---|
| Tool-call indicator / scrollback | agent calls any tool | `tool-lane.ts:43-70` |
| **Diff block** (`+`green / `-`red / `@@` hunk header, stat `+N -M across K hunks`) | `edit_file` / `write_file` | `tool-lane-format-diff.ts:82-266`, `palette.ts:72-77`, wired via `tool-lane.ts:516` |
| Subagent status `Agent(label)` | dispatch a subagent | `stream-renderer-subagent.ts` |
| Thinking preview + `◆ thought for Xs · N tok` | reasoning/thinking | `thinking-paragraph.ts`, `thinking-lane.ts:14` |
| **Interactive question overlay** — keyboard picker (choice/multi) or text input (text/number) | `ask_question` (5 types: text, confirm, choice, multi_choice, number) | `render/picker.ts`, `render/text-input.ts`, `elicitation/agent-question.ts:132-258`, `schemas.ts:874` |
| Progress banner | long-running op | `progress-banner.ts:79` |
| Loop-stage rail (Observe→Model→Choose→Act→Update) | runtime-driven | `loop-stage.ts` |
| Skill badge | invoke a skill (`<skillname>` tag) | `stream-renderer-orchestrator.ts:93-97` |
| Error box | a tool errors (e.g. `cat /no/such/file`) | `render/error-box.ts:23-37` |
| Verdict card (Done / Blocked / Asking / Interrupted) | end of turn (automatic on REPL) | `verdict-card.ts:43-60` |
| Cards (plan / status / checkpoint / diagnosis / user) | those flows emit them | `render/card.ts:35-60` |
| Usage-limit box | hitting a real usage limit (can't force) | `render/usage-limit-box.ts:21-60` |
| Streaming placeholders `▍ streaming code…` | transient mid-stream | `markdown-stream-format.ts:53-62` |
| Loading-tips spinner | any turn while the model works | `loading-tips.ts` |
| OSC 8 hyperlinks (clickable file paths) | with diffs / path labels | `tool-lane-render-agent.ts:272` |
| "Unverified" turn warning | text-only turns with no write/command | `afk-push.ts:153` |

### Slash / startup renderables (operator triggers these)

| Renderable | Trigger | Cite |
|---|---|---|
| Todo panel (`┌─ todos …`) | `/todo add <text>` | `todo-panel.ts:83-110`, `context-pane.ts:37-58` |
| Help table | `/help` | `render/help-table.ts` |
| Welcome banner | REPL startup | `render/welcome-banner.ts` |

---

## Rendering-related env toggles

| Env var | Effect | Cite |
|---|---|---|
| `AFK_SHOW_DIFFS` | `0`/`false`/`off`/`no` → disable diff rendering entirely | `tool-lane-format-diff.ts:65-70` |
| `AFK_DIFF_LINES` | scrollback diff cap (default 30; `0` = no cap) | `tool-lane-format-diff.ts:45-53` |

Overlay diff cap is fixed at 8 lines (`MAX_OVERLAY_DIFF_LINES`, `tool-lane-format-diff.ts:11`).

---

## Caveats

- The **usage-limit box** can't be forced safely (needs a real API limit).
- The **progress banner** and **loop-stage rail** are runtime-timed — may not appear on a fast turn.
- The **diff block** and **interactive picker** need a non-plan-mode session (file edits + questions).
- On **Telegram**, the table / lists / blockquote / rule / image show as raw markdown text — use the REPL for rich rendering.

---

*Paths are relative to `src/cli/` unless otherwise noted. Verified against `src/cli/formatter.ts`,
`src/cli/commands/interactive/tool-lane-format-diff.ts`, `src/cli/render/`, `src/telegram/formatter.ts`,
and the `ask_question` → elicitation → picker wiring. Three load-bearing claims (diff blocks,
ask_question picker overlay, strikethrough/image fallthrough) were independently shadow-verified — all CONFIRMED.*
