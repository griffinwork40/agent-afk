# HN Submission

**Title:** Show HN: Agent AFK -- I open-sourced the system prompt after my AI agent cloned itself 134 times

**URL:** https://graisol.com/blog/agent-forkbomb-system-prompt

---

# First Comment (post immediately after submission)

Author here. Agent AFK is an open-source autonomous coding agent (TypeScript CLI + daemon + Telegram bot) that runs Claude while you're AFK.

On Aug 9 the agent tried to discover its own capabilities by running a command that didn't exist. The CLI silently interpreted it as "start a new agent session." Recursive spawning hit 134 processes before I killed it.

The interesting part: the fix wasn't just technical. It was realizing the agent's instructions needed both principles ("act freely on reversible things, ask before irreversible ones") AND specific prohibitions for specific catastrophes -- same as production systems need both architecture and circuit breakers.

The full system prompt is public: https://github.com/griffinwork40/agent-afk/blob/main/prompts/system-prompt.md

Repo: https://github.com/griffinwork40/agent-afk (Apache-2.0)

The HN first comment can be a bit more technical than the blog post -- this audience will appreciate the Commander.js detail.
