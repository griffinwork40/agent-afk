"use client";

import { useRevealAll } from "../hooks/useReveal";

interface Feature {
  icon: string;
  title: string;
  description: string;
  detail: string;
}

const features: Feature[] = [
  {
    icon: "⟁",
    title: "Recursive Delegation",
    description:
      "A root agent decomposes work into a DAG of sub-agents that execute layer by layer -- nodes within a layer run in parallel, each in its own session with a 50-round tool budget.",
    detail:
      "Kahn-order execution with per-node AbortControllers, fail-fast transitive skip, and crash-resume checkpointing. Depth 3 by default, configurable to 6.",
  },
  {
    icon: "⚡",
    title: "Skill & Plugin System",
    description:
      "Ship features with /mint, debug with /diagnose, review PRs with /review. 50+ built-in skills, plus community plugins installed from GitHub URLs with hot-reload.",
    detail:
      "User-scope skills at ~/.afk/skills/ load every session. Plugins carry their own MCP configs, agent definitions, and tool surfaces. SHA-256 pinned in CI.",
  },
  {
    icon: "◉",
    title: "Witness Trace",
    description:
      "Every session writes a durable trace.jsonl -- every tool call with timing, byte counts, and SHA-256 fingerprints. Every sub-agent lifecycle event. Every hook decision.",
    detail:
      "Run afk trace show to pretty-print any session. Optional incremental sub-agent output capture that survives timeout kills. 30-day retention with 2 GiB cap.",
  },
  {
    icon: "⬡",
    title: "Daemon & Telegram",
    description:
      "afk daemon runs headless, fires tasks on cron expressions, and sends Telegram notifications when tasks complete or fail. You get a text message, not a blinking terminal.",
    detail:
      "Telegraf bot with per-chat sessions, model switching, and allowlist-gated access. Install as a macOS LaunchAgent or Linux systemd service for always-on operation.",
  },
  {
    icon: "⎇",
    title: "Worktree Isolation",
    description:
      "Each parallel sub-agent gets its own git worktree on a dedicated branch. Up to 16 speculative branches can run simultaneously without conflicting.",
    detail:
      "Managed under .afk-worktrees/ with ownership metadata. A background sweep engine reclaims stale trees automatically. Base ref locked at creation time.",
  },
  {
    icon: "◈",
    title: "Cross-Session Memory",
    description:
      "An FTS5-searchable SQLite archive of facts, decisions, learnings, and procedures that persists across sessions. Hot memory injects critical context into every prompt.",
    detail:
      "Three tools: memory_search, memory_update, procedure_write. Categories: preference, convention, decision, learning. Supersede preserves history.",
  },
];

export default function Features() {
  const ref = useRevealAll();

  return (
    <section id="features" className="relative py-24 px-6" ref={ref}>
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-16 reveal">
          <h2 className="text-3xl sm:text-4xl font-bold mb-4">
            Built for <span className="gradient-text">real autonomy</span>
          </h2>
          <p className="text-text-secondary max-w-2xl mx-auto">
            Not a chatbot wrapper. A full agent runtime with the infrastructure
            to let AI work unsupervised -- delegation, isolation, observability,
            and recovery built in.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feature, i) => (
            <div
              key={feature.title}
              className={`reveal reveal-delay-${i + 1} group relative p-6 rounded-xl border border-border-primary bg-bg-card hover:bg-bg-card-hover hover:border-accent-primary/30 transition-all duration-300`}
            >
              <div className="text-2xl mb-4 w-10 h-10 rounded-lg bg-accent-primary/10 flex items-center justify-center text-accent-secondary">
                {feature.icon}
              </div>
              <h3 className="text-lg font-semibold mb-2 text-text-primary">
                {feature.title}
              </h3>
              <p className="text-sm text-text-secondary leading-relaxed mb-3">
                {feature.description}
              </p>
              <p className="text-xs text-text-muted leading-relaxed opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                {feature.detail}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
