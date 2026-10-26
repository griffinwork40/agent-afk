import { useEffect } from "react";

interface KeyboardShortcutsProps {
  onNavigate: (nav: string) => void;
}

const NAV_MAP: Record<string, string> = {
  "1": "sessions",
  "2": "memory",
  "3": "schedules",
  "4": "jobs",
};

/**
 * Global keyboard shortcut handler.
 *
 * Shortcuts:
 *   Cmd/Ctrl + 1-4  — navigate sidebar sections
 *
 * Composer-level shortcuts (handled in composer.tsx, not here, because they
 * need access to the textarea focus state and isBusy):
 *   Escape          — stop a running turn (when composer is focused and busy)
 *   Cmd/Ctrl + .    — stop a running turn (anywhere)
 *   ArrowUp         — recall previous prompt (caret on first line)
 *   ArrowDown       — navigate forward through history
 *
 * Message-level shortcuts (handled in message-actions.tsx):
 *   (hover actions) — copy, retry, edit buttons revealed on hover
 */
export function KeyboardShortcuts({ onNavigate }: KeyboardShortcutsProps) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const nav = NAV_MAP[e.key];
      if (!nav) return;
      e.preventDefault();
      onNavigate(nav);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onNavigate]);

  return null;
}

// ---------------------------------------------------------------------------
// ShortcutHint — discoverable keyboard shortcut display used in help panels
// ---------------------------------------------------------------------------

/**
 * Renders a list of keyboard shortcuts for display in a help/shortcuts panel.
 * Pure presentational — no event handling.
 */
export function ShortcutList() {
  const shortcuts: Array<{ keys: string[]; description: string }> = [
    { keys: ['⌘', '1'], description: 'Go to Sessions' },
    { keys: ['⌘', '2'], description: 'Go to Memory' },
    { keys: ['⌘', '3'], description: 'Go to Schedules' },
    { keys: ['⌘', '4'], description: 'Go to Jobs' },
    { keys: ['Esc'], description: 'Stop running turn (composer focused)' },
    { keys: ['⌘', '.'], description: 'Stop running turn (anywhere)' },
    { keys: ['↑'], description: 'Recall previous prompt (caret on first line)' },
    { keys: ['↓'], description: 'Navigate forward through prompt history' },
    { keys: ['Enter'], description: 'Send message (or queue if turn is running)' },
    { keys: ['Shift', 'Enter'], description: 'New line in composer' },
    { keys: ['hover'], description: 'Copy / Retry / Edit message actions' },
  ];

  return (
    <div className="flex flex-col gap-1.5 text-sm">
      {shortcuts.map(({ keys, description }) => (
        <div key={description} className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">{description}</span>
          <div className="flex items-center gap-0.5 shrink-0">
            {keys.map((k, i) => (
              <span key={i}>
                <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                  {k}
                </kbd>
                {i < keys.length - 1 && (
                  <span className="mx-0.5 text-[10px] text-muted-foreground">+</span>
                )}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
