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
