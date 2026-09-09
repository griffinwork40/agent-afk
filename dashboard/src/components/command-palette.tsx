import { useEffect, useState } from 'react';
import { Command } from 'cmdk';
import {
  LayoutDashboard,
  Brain,
  CalendarClock,
  BriefcaseBusiness,
  Settings,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { label: 'Sessions', icon: LayoutDashboard, value: 'sessions' },
  { label: 'Memory', icon: Brain, value: 'memory' },
  { label: 'Schedules', icon: CalendarClock, value: 'schedules' },
  { label: 'Jobs', icon: BriefcaseBusiness, value: 'jobs' },
  { label: 'Settings', icon: Settings, value: 'settings' },
] as const;

type NavValue = (typeof NAV_ITEMS)[number]['value'];

interface CommandPaletteProps {
  onNavigate: (nav: string) => void;
}

export function CommandPalette({ onNavigate }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);

  // Toggle on Cmd+K / Ctrl+K
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const select = (value: NavValue) => {
    setOpen(false);
    onNavigate(value);
  };

  if (!open) return null;

  return (
    // Overlay
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
      onClick={() => setOpen(false)}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" aria-hidden />

      {/* Palette container */}
      <div
        className={cn(
          'relative z-10 w-full max-w-lg rounded-xl border border-border',
          'bg-popover text-popover-foreground shadow-2xl',
          'overflow-hidden',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <Command>
          {/* Search input */}
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <svg
              className="h-4 w-4 shrink-0 text-muted-foreground"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <Command.Input
              autoFocus
              placeholder="Search commands…"
              className={cn(
                'flex-1 bg-transparent text-sm outline-none',
                'placeholder:text-muted-foreground',
              )}
            />
            <kbd className="hidden rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground sm:inline-block">
              ESC
            </kbd>
          </div>

          {/* Item list */}
          <Command.List className="max-h-64 overflow-y-auto py-2">
            <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
              No results found.
            </Command.Empty>

            <Command.Group heading="Navigation" className="px-2">
              {NAV_ITEMS.map(({ label, icon: Icon, value }) => (
                <Command.Item
                  key={value}
                  value={value}
                  onSelect={() => select(value)}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm',
                    'text-popover-foreground transition-colors',
                    'data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground',
                  )}
                >
                  <Icon className="h-4 w-4 text-muted-foreground" />
                  {label}
                </Command.Item>
              ))}
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
