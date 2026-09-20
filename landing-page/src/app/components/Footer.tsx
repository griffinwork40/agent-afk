export default function Footer() {
  return (
    <footer className="border-t border-border-primary bg-bg-secondary/50 py-12 px-6">
      <div className="max-w-6xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-8">
          {/* Brand */}
          <div className="md:col-span-2">
            <div className="flex items-center gap-2 text-text-primary font-bold text-lg mb-3">
              <span className="text-accent-primary">&gt;_</span>
              <span>agent-afk</span>
            </div>
            <p className="text-sm text-text-secondary max-w-sm leading-relaxed">
              Autonomous AI agent runtime. Start a task and walk away -- it
              orchestrates, isolates, traces, and texts you when it&apos;s done.
            </p>
          </div>

          {/* Links */}
          <div>
            <h4 className="text-xs text-text-muted uppercase tracking-wider mb-3">
              Resources
            </h4>
            <ul className="space-y-2">
              <li>
                <a
                  href="https://docs.agentafk.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-text-secondary hover:text-text-primary transition-colors"
                >
                  Documentation
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/griffinwork40/agent-afk"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-text-secondary hover:text-text-primary transition-colors"
                >
                  GitHub
                </a>
              </li>
              <li>
                <a
                  href="https://www.npmjs.com/package/agent-afk"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-text-secondary hover:text-text-primary transition-colors"
                >
                  npm
                </a>
              </li>
            </ul>
          </div>

          <div>
            <h4 className="text-xs text-text-muted uppercase tracking-wider mb-3">
              Quick Start
            </h4>
            <ul className="space-y-2">
              <li>
                <a
                  href="#getting-started"
                  className="text-sm text-text-secondary hover:text-text-primary transition-colors"
                >
                  Install
                </a>
              </li>
              <li>
                <a
                  href="#features"
                  className="text-sm text-text-secondary hover:text-text-primary transition-colors"
                >
                  Features
                </a>
              </li>
              <li>
                <a
                  href="#architecture"
                  className="text-sm text-text-secondary hover:text-text-primary transition-colors"
                >
                  Architecture
                </a>
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom */}
        <div className="pt-8 border-t border-border-primary/50 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-xs text-text-muted">
            Built by{" "}
            <a
              href="https://github.com/griffinwork40"
              target="_blank"
              rel="noopener noreferrer"
              className="text-text-secondary hover:text-text-primary transition-colors"
            >
              Griffin Long
            </a>
          </p>
          <div className="flex items-center gap-1 text-xs text-text-muted">
            <span>MIT License</span>
            <span className="mx-2">&middot;</span>
            <code className="font-mono text-accent-secondary">
              npm i -g agent-afk
            </code>
          </div>
        </div>
      </div>
    </footer>
  );
}
