"use client";

import { useState } from "react";
import { useRevealAll } from "../hooks/useReveal";

interface Layer {
  id: string;
  label: string;
  sublabel: string;
  description: string;
  files: string;
  detail: string;
  color: string;
}

const layers: Layer[] = [
  {
    id: "surfaces",
    label: "Surfaces",
    sublabel: "CLI / REPL / Telegram / Daemon",
    description:
      "Three ways to interact: the terminal REPL with live markdown streaming, a bidirectional Telegram bot with per-chat sessions, and a headless daemon with cron scheduling.",
    files: "src/cli/ + src/telegram/ + src/agent/daemon/",
    detail: "Slash commands with Levenshtein hints, multi-session Telegram threads, LaunchAgent/systemd service install",
    color: "from-accent-cyan/20 to-accent-cyan/5",
  },
  {
    id: "session",
    label: "Session Harness",
    sublabel: "AgentSession + SubagentManager",
    description:
      "The single runtime entry point. Owns conversation history, tool dispatch, the turn loop, and sub-agent lifecycle. All surfaces construct AgentSession directly.",
    files: "src/agent/session/ + src/agent/subagent.ts",
    detail: "AbortGraph for cascading cancellation, DAG executor for parallel sub-agent layers, Zod output schemas",
    color: "from-accent-primary/20 to-accent-primary/5",
  },
  {
    id: "providers",
    label: "Provider Layer",
    sublabel: "Anthropic Direct / OpenAI Compatible / xAI",
    description:
      "Normalizes every model backend into a single ProviderEvent stream. No model SDK escapes this boundary. Switch between Claude, GPT, local models by name.",
    files: "src/agent/providers/",
    detail: "Layered retry stack, auto-compaction near context ceiling, stream-stall detection, HuggingFace org/model routing",
    color: "from-accent-secondary/20 to-accent-secondary/5",
  },
  {
    id: "tools",
    label: "Tool Surface",
    sublabel: "50+ built-in tools + MCP bridge",
    description:
      "File I/O, shell, git, browser automation, web scrape, memory, state store, workspace, agent dispatch, and any MCP server tool bridged as mcp__server__tool.",
    files: "src/agent/tools/ + src/agent/mcp/",
    detail: "Hook system with PreToolUse/PostToolUse gates, domain-policy enforcement, secret redaction on the wire",
    color: "from-accent-green/20 to-accent-green/5",
  },
  {
    id: "skills",
    label: "Skill System",
    sublabel: "/mint, /review, /diagnose, /ship + plugins",
    description:
      "Orchestrator skills that compose multi-phase agent workflows. Each phase forks sub-agents with markdown prompt files. Community plugins install from GitHub.",
    files: "src/skills/ + src/agent/plugins/",
    detail: "Plugin scanner descends 5 levels, hot-reload via /reload-plugins, SHA-256 pins on bundled skills",
    color: "from-accent-amber/20 to-accent-amber/5",
  },
  {
    id: "observability",
    label: "Observability",
    sublabel: "Witness Trace / Memory / Telemetry",
    description:
      "Durable trace.jsonl per session, cross-session FTS5 memory, incremental sub-agent output capture. The trace is the first artifact to reach for when reconstructing what happened.",
    files: "src/agent/trace/ + src/agent/memory/",
    detail: "Append-only writer with monotonic seq, compaction sidecars with SHA-256 hashes, 30-day retention sweep",
    color: "from-accent-red/20 to-accent-red/5",
  },
];

export default function Architecture() {
  const [activeLayer, setActiveLayer] = useState<string | null>(null);
  const ref = useRevealAll();

  const active = layers.find((l) => l.id === activeLayer);

  return (
    <section id="architecture" className="relative py-24 px-6" ref={ref}>
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-16 reveal">
          <h2 className="text-3xl sm:text-4xl font-bold mb-4">
            <span className="gradient-text">Architecture</span>
          </h2>
          <p className="text-text-secondary max-w-2xl mx-auto">
            Six layers compose the runtime. Hover or tap a layer to explore.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-8 items-start">
          {/* Layer stack */}
          <div className="lg:col-span-3 space-y-2 reveal reveal-delay-1">
            {layers.map((layer, i) => (
              <button
                key={layer.id}
                onMouseEnter={() => setActiveLayer(layer.id)}
                onMouseLeave={() => setActiveLayer(null)}
                onClick={() =>
                  setActiveLayer(activeLayer === layer.id ? null : layer.id)
                }
                className={`w-full text-left p-4 rounded-xl border transition-all duration-300 ${
                  activeLayer === layer.id
                    ? `border-accent-primary/40 bg-gradient-to-r ${layer.color} shadow-lg shadow-accent-primary/5`
                    : "border-border-primary bg-bg-card hover:border-border-primary/80"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-text-muted font-mono">
                        L{i}
                      </span>
                      <span className="font-semibold text-text-primary">
                        {layer.label}
                      </span>
                    </div>
                    <p className="text-xs text-text-muted mt-1 ml-7">
                      {layer.sublabel}
                    </p>
                  </div>
                  <svg
                    className={`w-4 h-4 text-text-muted transition-transform ${
                      activeLayer === layer.id ? "rotate-180" : ""
                    }`}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                  >
                    <path d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </button>
            ))}
          </div>

          {/* Detail panel */}
          <div className="lg:col-span-2 reveal reveal-delay-2">
            <div className="sticky top-24 p-6 rounded-xl border border-border-primary bg-bg-card min-h-[300px]">
              {active ? (
                <div className="animate-fade-in" key={active.id}>
                  <h3 className="text-lg font-bold text-text-primary mb-2">
                    {active.label}
                  </h3>
                  <p className="text-sm text-text-secondary leading-relaxed mb-4">
                    {active.description}
                  </p>
                  <div className="space-y-3">
                    <div>
                      <span className="text-xs text-text-muted uppercase tracking-wider">
                        Source
                      </span>
                      <p className="text-xs font-mono text-accent-secondary mt-1">
                        {active.files}
                      </p>
                    </div>
                    <div>
                      <span className="text-xs text-text-muted uppercase tracking-wider">
                        Key details
                      </span>
                      <p className="text-xs text-text-secondary mt-1">
                        {active.detail}
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-center h-full text-text-muted text-sm">
                  <div className="text-center">
                    <p className="text-2xl mb-2">&#9776;</p>
                    <p>Hover a layer to explore</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
