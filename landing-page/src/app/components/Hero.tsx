"use client";

import TerminalDemo from "./TerminalDemo";

export default function Hero() {
  return (
    <section className="relative min-h-screen flex flex-col items-center justify-center px-6 pt-24 pb-16 grid-bg overflow-hidden">
      {/* Ambient glow */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-accent-primary/5 rounded-full blur-[128px] pointer-events-none" />

      <div className="relative z-10 max-w-4xl mx-auto text-center mb-12">
        <div className="inline-flex items-center gap-2 px-3 py-1 mb-6 rounded-full border border-accent-primary/20 bg-accent-primary/5 text-sm text-accent-secondary animate-fade-in">
          <span className="w-2 h-2 rounded-full bg-accent-green animate-pulse" />
          Open Source &middot; TypeScript &middot; npm install -g agent-afk
        </div>

        <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight leading-[1.1] mb-6 animate-fade-in-up">
          Start a task.
          <br />
          <span className="gradient-text">Walk away.</span>
        </h1>

        <p className="text-lg sm:text-xl text-text-secondary max-w-2xl mx-auto mb-10 animate-fade-in-up" style={{ animationDelay: "0.15s" }}>
          agent-afk orchestrates parallel sub-agents across isolated git
          branches, tracks every decision in a durable witness trace, and texts
          you on Telegram when it&apos;s done.
        </p>

        <div
          className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16 animate-fade-in-up"
          style={{ animationDelay: "0.3s" }}
        >
          <a
            href="#getting-started"
            className="px-8 py-3 rounded-lg bg-accent-primary text-white font-medium hover:bg-accent-secondary transition-colors shadow-lg shadow-accent-primary/25"
          >
            Get Started
          </a>
          <a
            href="https://github.com/griffinwork40/agent-afk"
            target="_blank"
            rel="noopener noreferrer"
            className="px-8 py-3 rounded-lg border border-border-primary text-text-secondary hover:text-text-primary hover:border-accent-primary/40 transition-colors"
          >
            View on GitHub &rarr;
          </a>
        </div>
      </div>

      <div className="relative z-10 w-full animate-fade-in-up" style={{ animationDelay: "0.45s" }}>
        <TerminalDemo />
      </div>

      {/* Scroll indicator */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 animate-bounce text-text-muted">
        <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4 8l6 6 6-6" />
        </svg>
      </div>
    </section>
  );
}
