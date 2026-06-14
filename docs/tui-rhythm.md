# TUI rhythm contract

## The rule

**Every emitted block owns exactly one trailing blank line. No emitter
owns leading blanks.**

Where "block" = anything that lands in scrollback as a visually-distinct
unit: a paragraph of prose, a tool-lane flush, a subagent panel card, a
verdict card, the turn footer, the welcome banner, a background-task
completion card, the session summary, a SIGINT notice, the pre-arm
separator, etc.

Practical result: between any two blocks, you get exactly **one** blank
line. No doubles. No butt-joins. No "this category gets two and that one
gets zero" surprise.

## Why this rule (vs. tiered "major sections get 2 blanks")

Tiered rhythm requires every new emitter to consciously decide which
tier it belongs to, and the categories drift over time. Single-trailing
is one rule for everyone. The cost is that some elements that *could*
look denser (e.g. a list of tool results) are spaced consistently with
prose; in practice this reads as a calm cadence, not as excessive
whitespace.

## Documented exceptions (leading-owned)

A handful of emitters legitimately own a *leading* blank instead of a
trailing one. They share one property: their predecessor is
**uncontrolled** — i.e., not under the rhythm contract — so trailing
ownership can't be applied to the predecessor.

| Site | Predecessor | Why leading |
|------|-------------|-------------|
| `turn-handler.ts:169/171` pre-arm blank | Readline echo of user input | Readline output is not under the contract |
| `interactive.ts:385` SIGINT mid-stream | Partial overlay content interrupted mid-tick | Streaming chars were never committed with their trailing |
| `interactive.ts:402` SIGINT idle | Prompt waiting at input row | Consistency with mid-stream case |
| `interactive.ts:486` Welcome banner | Boot stdout (update notices, ANSI clear) | Boot-time output is not under the contract |

Every other emitter is trailing-owned. Adding a new emitter? Default to
**trailing**. Only choose leading if you can name the uncontrolled
predecessor it's interrupting.

## How `commitAbove` interacts with trailing newlines

`TerminalCompositor.commitAbove(text)` strips exactly **one** trailing
`\n` before writing to scrollback (see `terminal-compositor.ts:872`).
So:

- `commitAbove('')` → 1 blank line in scrollback
- `commitAbove('\n')` → 1 blank line (the `\n` is stripped — same as `''`)
- `commitAbove('text')` → `text` on one line, no trailing blank
- `commitAbove('text\n')` → `text` on one line, no trailing blank
- `commitAbove('text\n\n')` → `text` + 1 blank line ← **this is what trailing-owned blocks should produce**

The markdown stream uses the last form: `commitAbove(trimmed + '\n\n')`
at `markdown-stream.ts:220` so each paragraph block lands with its
trailing blank baked in.

For multi-line blocks emitted line-by-line (tool lane, subagent panel),
the pattern is:

```ts
for (const line of lines) compositor.commitAbove(line);
compositor.commitAbove('');  // ← trailing blank
```

## How the markdown renderer participates

`renderMarkdownToTerminal` (`formatter.ts`) is the source of assistant
prose. To keep it contract-clean for both the streaming REPL path and the
non-streamed paths (`afk chat`, `/transcript`, `/attach`):

- **Every block token emits exactly one trailing `\n`** (a line terminator,
  not a blank line) and **no leading blank**. The one blank line between
  blocks comes solely from marked's `space` token (one source blank line →
  one `\n`). Emitting `\n\n` from a block token *and* relying on the `space`
  token double-spaced every boundary in non-streamed rendering; a leading
  `\n` on headings produced a double blank before every heading in the REPL.
- `formatBlockForCommit` (`markdown-stream-format.ts`) strips **both** leading
  and trailing blank lines before `commitBlock` re-adds the single trailing
  blank — so a model emitting 3+ newlines between sections can't smuggle a
  leading blank into scrollback.

## Tests

`src/cli/_lib/rhythm-contract.test.ts` exercises the major emission
sites and asserts that each produces exactly one trailing blank with no
leading blank. When you add a new emitter, add a case there so future
drift gets caught.

## Sites under the contract (inventory)

Trailing-owned (the default):

- Markdown paragraph commits — `markdown-stream.ts:220`
- Tool-lane done-time flush — `stream-renderer-orchestrator.ts:368-375`
- Tool-lane inline flush (`flushToolLaneToScrollback`) — `stream-renderer-orchestrator.ts:454-473`
- Subagent done-block — `stream-renderer.ts:579/583`
- Subagent panel card — `stream-renderer-subagent.ts:495-510`
- Non-TTY thinking summary — `stream-renderer-subagent.ts:534-540`
- Verdict card — `turn-handler.ts:442`
- Turn footer — `turn-handler.ts:520`
- Soft-stop notice — `turn-handler.ts:390`
- Welcome banner — `interactive.ts:501`
- Session summary — `interactive.ts:598`
- Init-meta line — `repl-loop.ts:286`
- Plugin-shadowing notices — `repl-loop.ts:291`
- Background-task completion card — `repl-loop.ts:314`
- Context-pane — `repl-loop.ts:319`

Leading-owned (documented exceptions):

- Pre-arm separator — `turn-handler.ts:169/171`
- SIGINT mid-stream — `interactive.ts:385`
- SIGINT idle — `interactive.ts:402`
- Welcome banner (leading `\n` in string) — `interactive.ts:486`
