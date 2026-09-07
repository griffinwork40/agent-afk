---
name: render-test
description: "Render smoke-test for the agent-afk REPL: emit one of every markdown element (headings, bold/italic/strikethrough, inline + fenced code, GFM table, bullet/numbered/task lists, blockquote, link, image, horizontal rule) plus the runtime overlays (tool-call line, +/- edit diff, thinking, error box, subagent status, interactive picker, verdict card). Use to eyeball every renderer after touching TUI/formatter code, or to demo what afk can display. Pass `markdown` to emit only the markdown elements with no side effects."
context: load
---

# /render-test — TUI render smoke-test

You are running the render smoke-test in the CURRENT session. Produce the output below so the operator can visually inspect every renderer. Best run in the interactive REPL (`afk i`); the **diff block** and **interactive picker** only render **outside plan mode** (file edits + questions are what trigger them).

**Argument:** `$ARGUMENTS`
If the argument is `markdown` or `md`, emit ONLY Section A and stop — no file edits, no questions, no subagents. Otherwise do both sections.

---

## Section A — markdown elements

Emit each item as **live markdown** — not wrapped in a code block, not described in prose. One compact real example of each:

- An H1, an H2, and an H3 heading
- A paragraph containing **bold**, *italic*, ~~strikethrough~~, and `inline code`
- A fenced code block tagged `python` (a ~5-line snippet) so syntax highlighting shows
- A GFM table with 3 columns, a header row, and 2 data rows
- A bulleted list with one nested sub-bullet
- A numbered list that starts at 3
- A task list with one checked `[x]` and one unchecked `[ ]` item
- A two-line blockquote
- An inline `[link](https://example.com)` and a bare URL on its own line
- A markdown image: `![alt](https://example.com/x.png)`
- A horizontal rule

Do not wrap the whole reply in a fence.

> For your own grounding (do not lecture the operator unless asked): in the REPL, strikethrough and images render as **literal text** while tables/lists/code/etc. render richly; on Telegram it is the reverse (strikethrough → `<s>`, but tables/lists pass through as raw text). Full verified element map with file:line cites: `${SKILL_ROOT}/reference.md`.

---

## Section B — runtime overlays

Skip this section entirely if the argument was `markdown`/`md`. Otherwise perform these **safe, throwaway** actions so each overlay renders. Keep every artifact in the system temp dir — never write into the operator's repo.

1. Run `echo render-test-ok` — shows the tool-call line + result.
2. Run `cat /no/such/file` — shows the **error box** (a harmless, expected failure).
3. Show the **+/- diff block**: `write_file` a throwaway file at `/tmp/afk-render-test.txt` with 3 short lines, then `edit_file` to change one line (the diff renders under the edit), then delete it with `rm /tmp/afk-render-test.txt`.
4. Dispatch one cheap subagent (`model: haiku`, `max_turns: 1`) that returns a single-line fact — shows the `Agent(...)` status line.
5. Ask the operator ONE multiple-choice question via `ask_question` (`type: choice`, 3 options, e.g. "looks right / has glitches / skip") so the **interactive picker overlay** renders. First check reachability: if the surface is non-interactive (daemon/subagent/one-shot `chat`), SKIP this step and say the picker was skipped because no human is reachable.

Then close with your normal end-of-turn terminal-state summary — that emits the **verdict card**.

Overlays you cannot force from here (mention them, don't fake them): usage-limit box (needs a real API limit), progress banner / loop-stage rail (runtime-timed). Slash-only renderables the operator triggers manually: todo panel (`/todo add …`), help table (`/help`).
