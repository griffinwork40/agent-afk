/**
 * ⌘K command palette: sessions, slash commands and navigation in one
 * fuzzy-filtered, keyboard-driven list.
 *
 * Contract:
 * - ⌘K / Ctrl+K toggles; Escape (or a backdrop click) closes and returns focus
 *   to whatever was focused when it opened.
 * - Sessions (title + model) navigate to that session; slash commands insert
 *   `/<name> ` into the composer (only when a live session can take input);
 *   navigation items switch views. Arrow keys move, Enter selects (cmdk).
 * - Filtering scores each item's keywords with `fuzzyScore`; the item value is
 *   an opaque id and never matched.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Command } from 'cmdk';
import { MessageSquare, SquareSlash } from 'lucide-react';
import { cn } from '@/lib/utils';
import { listNavItems } from '@/lib/nav-registry';
import { paletteFilter } from '@/lib/fuzzy';
import { sessionDisplayTitle } from '@/lib/session-title';
import { formatSlashCommandName } from '@/lib/slash-command';
import type { SessionSummary, SlashCommand } from '@/types/api';
import { fetchCommands } from './composer';

interface CommandPaletteProps {
  onNavigate: (nav: string) => void;
  sessions?: readonly SessionSummary[];
  onSelectSession?: (sessionId: string) => void;
  /** Present only when a live composer can take the command text. */
  onInsertCommand?: (text: string) => void;
}

const itemClass = cn(
  'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm',
  'text-popover-foreground transition-colors',
  'data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground',
);
const groupClass = 'px-2 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-foreground/70';

export function CommandPalette({ onNavigate, sessions = [], onSelectSession, onInsertCommand }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Toggle on Cmd+K / Ctrl+K. Remember the focus owner BEFORE the input steals it.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((prev) => {
          if (!prev) returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          return !prev;
        });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    if (!open || !onInsertCommand) return;
    let cancelled = false;
    fetchCommands().then((cmds) => { if (!cancelled) setCommands(cmds ?? []); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [open, onInsertCommand]);

  /** Close. `restore` = put focus back where it was (Esc/backdrop), not after a selection. */
  const close = useCallback((restore: boolean) => {
    setOpen(false);
    if (!restore) return;
    const target = returnFocusRef.current;
    // After React removes the palette (and its focused input) from the DOM.
    setTimeout(() => { if (target?.isConnected) target.focus(); }, 0);
  }, []);

  if (!open) return null;

  const runnable = commands.filter((c) => c.web !== 'gated');
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-3 pt-[15vh]"
      onClick={() => close(true)}
      data-testid="command-palette"
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className={cn(
          'relative z-10 w-full max-w-lg rounded-xl border border-border',
          'bg-popover text-popover-foreground shadow-2xl',
          'overflow-hidden',
        )}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
        }}
      >
        <Command filter={paletteFilter} loop label="Command palette">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <svg className="h-4 w-4 shrink-0 text-muted-foreground" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <Command.Input
              autoFocus
              placeholder="Search sessions, commands, views…"
              className={cn('flex-1 bg-transparent text-sm outline-none', 'placeholder:text-muted-foreground')}
            />
            <kbd className="hidden rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground sm:inline-block">ESC</kbd>
          </div>

          <Command.List className="max-h-[min(60vh,24rem)] overflow-y-auto py-2">
            <Command.Empty className="py-6 text-center text-sm text-muted-foreground">No results found.</Command.Empty>

            {sessions.length > 0 && (
              <Command.Group heading="Sessions" className={groupClass}>
                {sessions.map((s) => {
                  const title = sessionDisplayTitle(s, s.mode === 'live' ? 'New session' : 'Untitled session');
                  return (
                    <Command.Item key={s.id} value={`session:${s.id}`} keywords={[title, s.model ?? '']}
                      onSelect={() => { close(false); onSelectSession?.(s.id); }} className={itemClass}>
                      <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{title}</span>
                      {s.model && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{s.model}</span>}
                    </Command.Item>
                  );
                })}
              </Command.Group>
            )}

            {onInsertCommand && runnable.length > 0 && (
              <Command.Group heading="Commands" className={groupClass}>
                {runnable.map((c) => {
                  const name = formatSlashCommandName(c.name);
                  return (
                    <Command.Item key={c.name} value={`command:${c.name}`} keywords={[name, c.summary]}
                      onSelect={() => { close(false); onInsertCommand(`${name} `); }} className={itemClass}>
                      <SquareSlash className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="shrink-0 font-mono text-xs">{name}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{c.summary}</span>
                    </Command.Item>
                  );
                })}
              </Command.Group>
            )}

            <Command.Group heading="Navigation" className={groupClass}>
              {listNavItems().map(({ id, label, title, icon: Icon }) => (
                <Command.Item key={id} value={`nav:${id}`} keywords={[label, title]}
                  onSelect={() => { close(false); onNavigate(id); }} className={itemClass}>
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
