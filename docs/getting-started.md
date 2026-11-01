# Getting Started with Agent AFK

> **Five minutes to productive.** This guide gets you from zero to your first real agent task. No prior coding-agent experience needed — if you've used Claude or ChatGPT, you're ready.

---

## 1. Install

```bash
npm install -g agent-afk
```

**Node 22.22.2+, 24.15+, or 26+** required. (23.x and 25.x are excluded.)

Want to try it before installing globally?

```bash
npx agent-afk chat "summarize the files in this directory"
```

After install, authenticate:

```bash
afk login       # auto-detects Claude Code / Codex credentials if you have them
afk doctor      # verify everything is wired up correctly
```

Already using **Claude Code or Codex?** `afk login` picks up your existing credentials automatically.

---

## 2. First run

There are two ways to talk to AFK:

### One-shot (pipe-friendly)

```bash
afk chat "what files changed in the last git commit and why does it matter?"
```

Runs one turn, prints the response, exits. Good for quick questions and scripts.

### Interactive REPL

```bash
afk
```

Opens a persistent session. The agent has full tool access: it can run bash commands, read and write files, search the web, and spawn sub-agents to parallelize work. Type your task and press Enter. Use `/help` to see available slash commands.

**A real first task to try:**

```bash
afk chat "look at the README in the current directory and give me a one-paragraph summary of what this project does"
```

---

## 3. What just happened — the witness trace

Every AFK session writes an **append-only witness trace**: a complete record of every tool call the agent made, every decision, every file it touched, and what it cost.

Read the trace from your last session:

```bash
afk trace show
```

You'll see something like:

```
[tool_call]  bash           -> git log --oneline -5
[tool_call]  read_file      -> README.md (1,842 bytes)
[tool_call]  bash           -> cat package.json
[session_sealed]  3 tool calls · $0.004 · 12s
```

This is your **learning tool**. When the agent does something unexpected, `afk trace show` tells you exactly what it did and in what order. Every run is auditable.

A few useful trace commands:

```bash
afk trace list              # list recent sessions
afk trace show              # pretty-print the latest session
afk trace show --all        # include every event kind
afk trace show -n 20        # limit to the last 20 events
```

Full reference: [`docs/afk-trace.md`](afk-trace.md)

---

## 4. Three core capabilities

### Interactive REPL

```bash
afk
```

The REPL is where you do real work. The agent can run commands, edit files, search code, open URLs, and reason across multiple steps. Sessions persist in `~/.afk/` so you can pick up where you left off.

**Example:**

```
> find all TODO comments in this repo and group them by file
```

The agent will grep, read, and summarize.

---

### One-shot tasks

```bash
afk chat "does this project have any tests that are marked as skipped?"
```

One-shot mode fires a single turn and exits with a zero/non-zero status code, making it easy to use in scripts and CI pipelines. Add `--model haiku` for speed, `--model opus` for hard reasoning.

---

### Telegram bot

Set up once, then send tasks from anywhere and get pings when they finish:

```bash
afk telegram setup      # walks you through bot token + chat allowlist
afk telegram start      # start the bot
```

After setup, message your bot from Telegram exactly like you'd use the REPL.

---

## 5. What AFK is NOT

- **Not a chatbot.** AFK is a tool-using agent. It runs bash, edits files, fetches URLs, spawns sub-agents. If you want a conversational assistant with no side effects, use Claude directly.
- **Not a CI system.** AFK runs on your machine, under your account, with your credentials. It's not a replacement for GitHub Actions.
- **Not a replacement for your editor.** AFK writes code, but you review it. Think of it as a collaborator that does the groundwork and hands you something to verify.

---

## 6. Where to go next

| Resource | What it covers |
|---|---|
| [README.md](../README.md) | Full feature overview: memory, models, daemon, permissions |
| `/get-started` skill | Interactive onboarding inside AFK (run it in the REPL) |
| `AFK.md` in your project root | Drop one here to give AFK project-specific context |
| `afk doctor` | Environment self-check |
| `afk --help` | Full command reference |

**Project context tip:** Create an `AFK.md` file in your project root:

```bash
cat > AFK.md << 'EOF'
# Project context for AFK

- Language: TypeScript, Node 22
- Test command: pnpm test
- Lint: pnpm lint
- Main branch: main
EOF
```

AFK reads this automatically whenever you run from that directory.

---

> **Next step:** run `afk` and give it a real task from your project. The trace is your receipt — read it with `afk trace show` after.
