# I open-sourced the system prompt that runs my autonomous coding agent. Here's why it's shaped the way it is.

I've been building [agent-afk](https://github.com/griffinwork40/agent-afk) -- a standalone TypeScript CLI + daemon + Telegram bot that runs Claude autonomously outside of Claude Code. The user is usually AFK (away from keyboard), so the agent has to make real decisions, not just ask permission for everything.

The full system prompt is [here](https://github.com/griffinwork40/agent-afk/blob/main/prompts/system-prompt.md). Below are the design decisions I found most interesting to land on, and why.

---

## 1. "High agency, bounded by reversibility"

This is the core operating rule. Most agent prompts either make the model too passive (asks before every action) or too reckless (yolo mode). The line I landed on:

> Act without asking when intent is clear and the action is reversible. Ask only when the next action depends on missing information, or when proceeding would cross an irreversible, external, or shared-resource boundary.

In practice this means the agent will create files, edit code, run tests, and commit to branches without asking -- but it stops cold before force-pushing, deleting data, messaging third parties, or calling paid APIs. The boundary isn't "important vs. unimportant," it's "can I undo this."

## 2. Every turn must end in a terminal state

The agent can't just trail off. Every turn ends in exactly one of:

- **Done** -- objective satisfied, with evidence (file path, commit SHA, test output)
- **Blocked** -- external dependency prevents progress, with the exact unblock condition
- **Asking** -- one precise question before the next action
- **Interrupted** -- user halted work, state preserved for resumption

This sounds rigid but it solves a real problem: when you come back to your laptop after an hour, you need to know instantly whether the agent finished, got stuck, or needs something from you. No more scrolling through 200 lines of output trying to figure out what happened.

## 3. Answer the "why" before shipping a fix

This one came from a recurring failure mode where the agent would silently reframe diagnostic questions into implementation tasks:

> A goal phrased as a question -- "why does X keep happening" -- asks for an explanation, not (only) a patch. The failure mode is silent substitution: reframing the diagnostic question into an implementation task, shipping a fix, and reporting success while the original "why" goes unanswered.

You ask "why does this test keep flaking?" and the agent rewrites the test to not flake anymore. Great, except you still don't know *why*, and the underlying issue is probably still there. The prompt now forces diagnosis before prescription.

## 4. Explicit anti-patterns to cut

There's a "What to cut" section that I wish more agent prompts had:

> - Persona flavor such as "I'll be happy to..."
> - Architectural self-narration to the user
> - "Based on my understanding..." preambles
> - Confirmation questions for clearly reversible actions the user already authorized

Every token spent on "Great question! I'd be happy to help you with that!" is a token not spent on the actual work. When you're reviewing agent output async, filler is actively hostile to comprehension.

## 5. The delegation framework

The agent can spawn sub-agents, and the prompt has explicit rules for when to delegate vs. stay inline:

> Default to delegation for any task that would otherwise: read or grep more than 3 files inline, verify a claim independently from the chain that produced it, investigate a failing test, or run two or more independent investigations that could happen in parallel.

> Stay inline for: single-file edits, localized fixes visible in <2 reads, conversational answers, and tasks where dispatch overhead exceeds the work.

The key insight is that the main session is the *coordinator*, not the investigator. It keeps synthesis and judgment; it delegates search, test, and verify.

---

## What I'd change if I started over

Honestly, not much structurally. The biggest ongoing challenge is calibrating the reversibility boundary -- there are gray areas (is creating a git branch reversible? yes. is pushing it to a remote? mostly yes, but now other people might see it). The prompt handles this with "explicit recent intent" as the tiebreaker, which works but isn't elegant.

The terminal-state protocol also creates a failure mode where the agent sometimes forces a "Done" when it should say "Blocked" -- it's trained to complete, so admitting it's stuck takes explicit prompting.

Full prompt: [prompts/system-prompt.md](https://github.com/griffinwork40/agent-afk/blob/main/prompts/system-prompt.md)  
Repo: [github.com/griffinwork40/agent-afk](https://github.com/griffinwork40/agent-afk)

Happy to answer questions about any of the design decisions.
