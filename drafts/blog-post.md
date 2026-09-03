# I Gave an Autonomous Agent Full Tool Access. It Forkbombed My Machine.

On August 9th, 2026, I watched an agent I built spawn 134 live processes on my laptop. It wasn't malicious. It wasn't a bug in the traditional sense. The agent was trying to be helpful -- and that was the problem.

I've been building [Agent AFK](https://github.com/griffinwork40/agent-afk), an open-source autonomous coding agent that runs while you're away from your keyboard. It has full shell access, can edit files, commit code, spawn sub-agents, and talk to external services. The system prompt that governs its behavior is [public](https://github.com/griffinwork40/agent-afk/blob/main/prompts/system-prompt.md). After the forkbomb, I rewrote parts of it. Here's what happened and what I learned.

## What Happened

Agent AFK's CLI binary is `afk`. It's built with Commander.js, which has a default command -- `interactive` -- that accepts a variadic `[input...]` argument. This means any unrecognized subcommand gets silently interpreted as a prompt to the interactive REPL.

There is no `afk skill` subcommand. But the agent didn't know that.

During a session, the agent decided it needed to discover available skills. It ran `afk skill list`. Commander didn't reject it -- it swallowed "skill" and "list" as arguments to the default command and launched a new interactive agent session. That session, trying to complete its task, spawned more agents. Each of those spawned more. Within seconds: 134 processes, climbing.

The agent wasn't broken. It was following reasonable logic -- "I should check what skills are available" -- through a CLI interface that never said no. The result was a forkbomb built entirely out of good intentions.

## The Fix Was a Rule, Not a Patch

The first instinct was to fix Commander's routing -- add an explicit error for unknown subcommands. And we did that. But the deeper problem wasn't the CLI. It was that the agent had no principle telling it "don't shell out to your own binary from inside a session."

So the system prompt now has this, marked as a critical safety rule:

> **DANGER -- never run `afk <unknown-subcommand>` from inside an agent session.** `interactive` is registered as commander's DEFAULT command with a variadic `[input...]` argument, so an unrecognized subcommand is silently reinterpreted as a REPL prompt and launches a nested agent session.

This is ugly. It's a specific, concrete prohibition for a specific failure. But it works, and it taught me something about how agent guardrails actually function in practice.

## What This Changed About How I Think About Agent Design

Before the forkbomb, the system prompt had a clean philosophy section about when agents should act versus ask. After the forkbomb, I realized the philosophy was necessary but not sufficient. You also need specific rules for specific failure modes -- the same way production systems need both design principles and circuit breakers.

The system prompt now operates on three layers:

**1. A core operating rule: "High agency, bounded by reversibility."**

The agent acts freely on reversible actions (editing files, running tests, committing to branches) and stops to ask before irreversible ones (force-pushing, deleting data, messaging third parties, calling paid APIs). The boundary isn't importance -- it's undoability.

**2. Terminal states that force clarity.**

Every turn must end in exactly one of four states: Done (with evidence), Blocked (with the exact unblock condition), Asking (one question), or Interrupted (state preserved). No trailing off. No ambiguous endings. When you come back to your laptop after an hour, you know instantly what happened.

**3. Specific prohibitions for specific catastrophes.**

The forkbomb rule. The rule against invoking `launchctl` or `systemctl` directly (use the managed service installer instead). The rule against constructing shell commands with markdown in double quotes (which silently corrupts through backtick substitution). These aren't elegant. They're scar tissue. They work.

## The Part I'm Still Figuring Out

The reversibility boundary has gray areas. Creating a git branch is reversible. Pushing it to a remote is mostly reversible -- but now other people might see it. Posting a comment on a PR is technically deletable -- but someone might have already read it.

The current tiebreaker is "explicit recent intent" -- if the user recently expressed the intent, proceed; otherwise ask. It works but it's not elegant, and I suspect there's a better formulation I haven't found yet.

The other open question: the terminal-state protocol (Done/Blocked/Asking/Interrupted) sometimes creates a failure mode where the agent forces a "Done" when it should admit it's stuck. Language models are trained to complete. Getting one to say "I'm blocked and here's why" takes active effort in the prompt.

If you're building agentic systems and have landed on better heuristics for either of these, I'd genuinely like to hear about it.

---

The full system prompt is [here](https://github.com/griffinwork40/agent-afk/blob/main/prompts/system-prompt.md). The repo is [github.com/griffinwork40/agent-afk](https://github.com/griffinwork40/agent-afk). It's open source, Apache-2.0.
