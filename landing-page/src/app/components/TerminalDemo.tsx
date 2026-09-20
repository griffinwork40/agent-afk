"use client";

import { useState, useEffect, useCallback } from "react";

interface TerminalLine {
  type: "prompt" | "command" | "output" | "accent" | "success" | "dim" | "blank";
  text: string;
  delay: number;
}

const lines: TerminalLine[] = [
  { type: "prompt", text: "$ npm install -g agent-afk", delay: 0 },
  { type: "dim", text: "added 1 package in 3.2s", delay: 800 },
  { type: "blank", text: "", delay: 200 },
  { type: "prompt", text: "$ afk", delay: 600 },
  { type: "accent", text: "  agent-afk v5.223.0", delay: 300 },
  { type: "dim", text: "  model: sonnet  |  session: 7f2a9c  |  branch: main", delay: 200 },
  { type: "blank", text: "", delay: 200 },
  { type: "output", text: "  > Add OAuth2 PKCE flow to the auth module", delay: 1000 },
  { type: "blank", text: "", delay: 400 },
  { type: "accent", text: "  ┌ Dispatching research-agent (read-only)...", delay: 600 },
  { type: "dim", text: "  │ Mapping src/auth/ exports and integration points", delay: 400 },
  { type: "accent", text: "  ├ Dispatching 3 parallel sub-agents via compose:", delay: 700 },
  { type: "success", text: "  │  ├─ [auth-research]  scanning OAuth2 RFC 7636 + existing flow", delay: 300 },
  { type: "success", text: "  │  ├─ [test-writer]    generating PKCE challenge/verifier tests", delay: 200 },
  { type: "success", text: "  │  └─ [impl-agent]     building in worktree afk/oauth-pkce", delay: 200 },
  { type: "blank", text: "", delay: 1200 },
  { type: "dim", text: "  │ auth-research    ✓ done (8 tool rounds, 12.3s)", delay: 500 },
  { type: "dim", text: "  │ test-writer      ✓ done (11 tool rounds, 18.1s)", delay: 400 },
  { type: "dim", text: "  │ impl-agent       ✓ done (23 tool rounds, 41.7s)", delay: 600 },
  { type: "accent", text: "  └ All sub-agents settled.", delay: 400 },
  { type: "blank", text: "", delay: 300 },
  { type: "success", text: "  ✓ 4 files changed  |  src/auth/pkce.ts (new)", delay: 400 },
  { type: "success", text: "  ✓ 12/12 tests passing  |  witness trace: ~/.afk/state/witness/7f2a9c/", delay: 300 },
  { type: "accent", text: "  ✓ Pushed to branch afk/oauth-pkce  |  PR #247 opened", delay: 400 },
  { type: "blank", text: "", delay: 200 },
  { type: "dim", text: "  📱 Telegram: \"Done. PR #247 ready for review.\"", delay: 600 },
];

export default function TerminalDemo() {
  const [visibleLines, setVisibleLines] = useState<number>(0);
  const [isTyping, setIsTyping] = useState(true);

  const animate = useCallback(() => {
    let currentLine = 0;
    let totalDelay = 0;

    const timers: ReturnType<typeof setTimeout>[] = [];

    lines.forEach((line, index) => {
      totalDelay += line.delay;
      const timer = setTimeout(() => {
        setVisibleLines(index + 1);
        currentLine = index;
        if (index === lines.length - 1) {
          setIsTyping(false);
        }
      }, totalDelay);
      timers.push(timer);
    });

    return () => timers.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    const cleanup = animate();
    return cleanup;
  }, [animate]);

  const renderLine = (line: TerminalLine, index: number) => {
    if (index >= visibleLines) return null;

    const colorMap: Record<TerminalLine["type"], string> = {
      prompt: "text-terminal-prompt",
      command: "text-terminal-command",
      output: "text-text-primary font-medium",
      accent: "text-terminal-accent",
      success: "text-accent-green",
      dim: "text-terminal-output",
      blank: "",
    };

    return (
      <div
        key={index}
        className={`${colorMap[line.type]} animate-fade-in`}
        style={{ minHeight: line.type === "blank" ? "1rem" : undefined }}
      >
        {line.text}
      </div>
    );
  };

  return (
    <div className="w-full max-w-2xl mx-auto">
      <div className="rounded-xl border border-terminal-border bg-terminal-bg shadow-2xl shadow-accent-primary/5 overflow-hidden">
        {/* Title bar */}
        <div className="flex items-center gap-2 px-4 py-3 bg-bg-secondary/50 border-b border-terminal-border">
          <div className="w-3 h-3 rounded-full bg-accent-red/80" />
          <div className="w-3 h-3 rounded-full bg-accent-amber/80" />
          <div className="w-3 h-3 rounded-full bg-accent-green/80" />
          <span className="ml-2 text-xs text-text-muted">agent-afk</span>
        </div>

        {/* Terminal content */}
        <div className="p-5 font-mono text-sm leading-relaxed overflow-x-auto">
          {lines.map((line, i) => renderLine(line, i))}
          {isTyping && (
            <span className="terminal-cursor inline-block w-2 h-4 bg-terminal-prompt ml-1" />
          )}
        </div>
      </div>
    </div>
  );
}
