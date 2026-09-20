"use client";

import { useRevealAll } from "../hooks/useReveal";

type Support = "full" | "partial" | "none";

interface CompRow {
  feature: string;
  afk: { level: Support; note: string };
  claudeCode: { level: Support; note: string };
  codexCli: { level: Support; note: string };
  cursor: { level: Support; note: string };
}

const rows: CompRow[] = [
  {
    feature: "Recursive sub-agent delegation",
    afk: { level: "full", note: "DAG executor, Kahn-order parallel layers, depth 3 (max 6)" },
    claudeCode: { level: "full", note: "Depth 3 default, background by default since v2.1" },
    codexCli: { level: "partial", note: "Depth 1 default, max 6 concurrent threads" },
    cursor: { level: "partial", note: "Depth 2 since Cursor 2.5" },
  },
  {
    feature: "Background daemon / cron",
    afk: { level: "full", note: "afk daemon with cron scheduler, SQLite task queue, LaunchAgent" },
    claudeCode: { level: "partial", note: "Cloud Routines, not a local daemon" },
    codexCli: { level: "partial", note: "Remote-control server, not a cron runner" },
    cursor: { level: "partial", note: "Cloud Agents (paid, cloud-only)" },
  },
  {
    feature: "Cross-session memory",
    afk: { level: "full", note: "FTS5 SQLite archive: facts, decisions, learnings, procedures" },
    claudeCode: { level: "none", note: "No persistent memory. 200-line MEMORY.md cap" },
    codexCli: { level: "full", note: "AI extraction pipeline, 256-rollout cap, 30-day prune" },
    cursor: { level: "none", note: "No native memory between sessions" },
  },
  {
    feature: "Push notifications",
    afk: { level: "full", note: "Full bidirectional Telegram bot with per-chat sessions" },
    claudeCode: { level: "none", note: "No push notifications" },
    codexCli: { level: "none", note: "No push notifications" },
    cursor: { level: "partial", note: "Slack integration for cloud agents only" },
  },
  {
    feature: "Skill & plugin ecosystem",
    afk: { level: "full", note: "50+ skills, GitHub-installable plugins, SHA-256 pinned" },
    claudeCode: { level: "full", note: "Agents, Skills, plugin marketplace, 6 hook types" },
    codexCli: { level: "partial", note: "Config YAML agents, CSV fan-out" },
    cursor: { level: "full", note: "Rules, MCP servers, 30+ partner integrations" },
  },
  {
    feature: "Worktree isolation",
    afk: { level: "full", note: "Managed worktrees with sweep engine, up to 16 parallel" },
    claudeCode: { level: "full", note: "Auto-worktree per dispatched agent" },
    codexCli: { level: "none", note: "No native worktree management" },
    cursor: { level: "full", note: "/worktree command + cloud VM isolation" },
  },
  {
    feature: "Structured observability",
    afk: { level: "full", note: "Durable trace.jsonl, afk trace show CLI, incremental capture" },
    claudeCode: { level: "partial", note: "Session transcripts, no structured trace CLI" },
    codexCli: { level: "partial", note: "SQLite threads, --json flag" },
    cursor: { level: "partial", note: "Cloud screenshots and run logs" },
  },
  {
    feature: "Multi-provider support",
    afk: { level: "full", note: "Anthropic, OpenAI, xAI, local (MLX, llama.cpp, ollama)" },
    claudeCode: { level: "none", note: "Anthropic models only" },
    codexCli: { level: "none", note: "OpenAI models only" },
    cursor: { level: "full", note: "Multiple providers via API keys" },
  },
  {
    feature: "Open source",
    afk: { level: "full", note: "MIT licensed, npm package" },
    claudeCode: { level: "full", note: "Open source (Anthropic)" },
    codexCli: { level: "full", note: "Open source (OpenAI)" },
    cursor: { level: "none", note: "Proprietary, paid plans" },
  },
];

function Badge({ level }: { level: Support }) {
  const styles: Record<Support, string> = {
    full: "bg-accent-green/10 text-accent-green border-accent-green/20",
    partial: "bg-accent-amber/10 text-accent-amber border-accent-amber/20",
    none: "bg-bg-tertiary text-text-muted border-border-primary",
  };

  const labels: Record<Support, string> = {
    full: "Yes",
    partial: "Partial",
    none: "No",
  };

  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-xs font-medium border ${styles[level]}`}
    >
      {labels[level]}
    </span>
  );
}

export default function Comparison() {
  const ref = useRevealAll();

  return (
    <section id="comparison" className="relative py-24 px-6" ref={ref}>
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-12 reveal">
          <h2 className="text-3xl sm:text-4xl font-bold mb-4">
            Honest <span className="gradient-text">comparison</span>
          </h2>
          <p className="text-text-secondary max-w-2xl mx-auto">
            Every tool has tradeoffs. Here&apos;s where agent-afk fits compared
            to other AI coding agents. Claims are sourced from each
            tool&apos;s public documentation.
          </p>
        </div>

        <div className="reveal reveal-delay-1 overflow-x-auto rounded-xl border border-border-primary">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-bg-secondary border-b border-border-primary">
                <th className="text-left px-4 py-3 text-text-muted font-medium min-w-[180px]">
                  Capability
                </th>
                <th className="text-center px-4 py-3 text-accent-secondary font-semibold min-w-[160px]">
                  agent-afk
                </th>
                <th className="text-center px-4 py-3 text-text-muted font-medium min-w-[160px]">
                  Claude Code
                </th>
                <th className="text-center px-4 py-3 text-text-muted font-medium min-w-[160px]">
                  Codex CLI
                </th>
                <th className="text-center px-4 py-3 text-text-muted font-medium min-w-[160px]">
                  Cursor
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={row.feature}
                  className={`border-b border-border-primary/50 hover:bg-bg-tertiary/30 transition-colors ${
                    i % 2 === 0 ? "bg-bg-card/30" : ""
                  }`}
                >
                  <td className="px-4 py-3 text-text-primary font-medium">
                    {row.feature}
                  </td>
                  {[row.afk, row.claudeCode, row.codexCli, row.cursor].map(
                    (cell, j) => (
                      <td key={j} className="px-4 py-3 text-center group relative">
                        <Badge level={cell.level} />
                        <div className="hidden group-hover:block absolute z-10 bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-bg-secondary border border-border-primary rounded-lg text-xs text-text-secondary whitespace-nowrap max-w-[250px] text-wrap shadow-lg">
                          {cell.note}
                        </div>
                      </td>
                    )
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-center text-xs text-text-muted mt-4">
          Hover any badge for details. Last updated September 2026.
        </p>
      </div>
    </section>
  );
}
