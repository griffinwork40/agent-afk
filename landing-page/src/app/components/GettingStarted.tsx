"use client";

import { useState } from "react";
import { useRevealAll } from "../hooks/useReveal";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="absolute right-3 top-3 px-2 py-1 rounded text-xs border border-border-primary bg-bg-secondary text-text-muted hover:text-text-primary hover:border-accent-primary/30 transition-colors"
      aria-label="Copy to clipboard"
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

interface Step {
  number: string;
  title: string;
  description: string;
  code: string;
}

const steps: Step[] = [
  {
    number: "01",
    title: "Install",
    description: "One command. Node 22+, any platform.",
    code: "npm install -g agent-afk",
  },
  {
    number: "02",
    title: "Configure",
    description: "Set your Anthropic API key (or use OpenAI, local models).",
    code: "export ANTHROPIC_API_KEY=sk-ant-...\n# or: export OPENAI_API_KEY=sk-...",
  },
  {
    number: "03",
    title: "Start the REPL",
    description: "Interactive session with live markdown streaming.",
    code: "afk",
  },
  {
    number: "04",
    title: "Give it a task and walk away",
    description:
      "It dispatches sub-agents, isolates work in worktrees, and texts you when done.",
    code: '> Refactor the auth module to use PKCE\n\n┌ Dispatching research-agent...\n├ Dispatching 3 parallel sub-agents\n│  ├─ [research]  scanning RFC 7636\n│  ├─ [implement] building in worktree\n│  └─ [test]      writing verification\n└ All sub-agents settled.\n\n✓ PR #247 opened | 📱 "Done."',
  },
];

export default function GettingStarted() {
  const ref = useRevealAll();

  return (
    <section id="getting-started" className="relative py-24 px-6" ref={ref}>
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-16 reveal">
          <h2 className="text-3xl sm:text-4xl font-bold mb-4">
            Get <span className="gradient-text">started</span>
          </h2>
          <p className="text-text-secondary">
            From zero to autonomous agent in under a minute.
          </p>
        </div>

        <div className="space-y-6">
          {steps.map((step, i) => (
            <div
              key={step.number}
              className={`reveal reveal-delay-${i + 1} grid grid-cols-1 md:grid-cols-[120px_1fr] gap-4 items-start`}
            >
              {/* Step number */}
              <div className="flex items-center gap-3 md:flex-col md:items-start">
                <span className="text-3xl font-bold text-accent-primary/30 font-mono">
                  {step.number}
                </span>
                <h3 className="text-lg font-semibold text-text-primary">
                  {step.title}
                </h3>
              </div>

              {/* Content */}
              <div>
                <p className="text-sm text-text-secondary mb-3">
                  {step.description}
                </p>
                <div className="relative rounded-xl border border-terminal-border bg-terminal-bg overflow-hidden">
                  <CopyButton text={step.code} />
                  <pre className="p-4 pr-20 text-sm font-mono overflow-x-auto">
                    <code className="text-terminal-output">
                      {step.code.split("\n").map((line, j) => (
                        <span key={j} className="block">
                          {line.startsWith("$") || line.startsWith(">") ? (
                            <>
                              <span className="text-terminal-prompt">
                                {line.charAt(0)}{" "}
                              </span>
                              <span className="text-terminal-command">
                                {line.slice(2)}
                              </span>
                            </>
                          ) : line.startsWith("#") ? (
                            <span className="text-text-muted">{line}</span>
                          ) : line.startsWith("✓") || line.startsWith("┌") || line.startsWith("├") || line.startsWith("│") || line.startsWith("└") ? (
                            <span className="text-terminal-accent">{line}</span>
                          ) : (
                            line
                          )}
                        </span>
                      ))}
                    </code>
                  </pre>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Extra links */}
        <div className="mt-16 text-center reveal reveal-delay-5">
          <p className="text-text-muted text-sm mb-4">
            Want the full walkthrough?
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <a
              href="https://docs.agentafk.com"
              target="_blank"
              rel="noopener noreferrer"
              className="px-6 py-3 rounded-lg bg-accent-primary text-white font-medium hover:bg-accent-secondary transition-colors shadow-lg shadow-accent-primary/25"
            >
              Read the Docs
            </a>
            <a
              href="https://github.com/griffinwork40/agent-afk"
              target="_blank"
              rel="noopener noreferrer"
              className="px-6 py-3 rounded-lg border border-border-primary text-text-secondary hover:text-text-primary hover:border-accent-primary/40 transition-colors"
            >
              View Source &rarr;
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
