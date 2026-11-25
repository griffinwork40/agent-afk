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
 * - Commands are grouped: recently-used first, then native commands, then
 *   skills. Summaries are capped at SUMMARY_CAP chars in the display but the
 *   full text remains searchable via `keywords`.
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

// ---------------------------------------------------------------------------
// Recent-command tracking (localStorage, same pattern as afk:draft:*)
// ---------------------------------------------------------------------------

const RECENT_KEY = 'afk:palette:recent-commands';
const MAX_RECENT = 5;
/** Cap displayed summaries; full text remains in `keywords` for search. */
export const SUMMARY_CAP = 60;

export function getRecentCommands(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function recordRecentCommand(name: string): void {
  try {
    const list = getRecentCommands().filter((n) => n !== name);
    list.unshift(name);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
  } catch {
    // Ignore storage errors.
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CommandPalette({ onNavigate, sessions = [], onSelectSession, onInsertCommand }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [recentNames, setRecentNames] = useState<string[]>([]);
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
    setRecentNames(getRecentCommands());
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

  // Partition into recent / native / skills / other groups.
  const recentSet = new Set(recentNames);
  const recent = recentNames
    .map((n) => runnable.find((c) => c.name === n))
    .filter((c): c is SlashCommand => c !== undefined);
  const natives = runnable.filter((c) => c.kind === 'native' && !recentSet.has(c.name));
  const skills  = runnable.filter((c) => c.kind === 'skill'  && !recentSet.has(c.name));
  // Catch-all for any future `kind` values not covered above.
  const others  = runnable.filter((c) => c.kind !== 'native' && c.kind !== 'skill' && !recentSet.has(c.name));

  function renderCommand(c: SlashCommand, groupPrefix: string) {
    const name = formatSlashCommandName(c.name);
    // Use code-point-safe slicing to avoid splitting surrogate pairs (emoji, etc.).
    const codePoints = Array.from(c.summary);
    const displaySummary = codePoints.length > SUMMARY_CAP
      ? `${codePoints.slice(0, SUMMARY_CAP).join('')}…`
      : c.summary;
    return (
      <Command.Item
        key={`${groupPrefix}:${c.name}`}
        value={`${groupPrefix}:command:${c.name}`}
        keywords={[name, c.summary]}
        onSelect={() => { recordRecentCommand(c.name); close(false); onInsertCommand?.(`${name} `); }}
        className={itemClass}
      >
        <SquareSlash className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-mono text-xs">{name}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{displaySummary}</span>
      </Command.Item>
    );
  }

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

            {onInsertCommand && recent.length > 0 && (
              <Command.Group heading="Recent" className={groupClass}>
                {recent.map((c) => renderCommand(c, 'recent'))}
              </Command.Group>
            )}

            {onInsertCommand && natives.length > 0 && (
              <Command.Group heading="Commands" className={groupClass}>
                {natives.map((c) => renderCommand(c, 'native'))}
              </Command.Group>
            )}

            {onInsertCommand && skills.length > 0 && (
              <Command.Group heading="Skills" className={groupClass}>
                {skills.map((c) => renderCommand(c, 'skill'))}
              </Command.Group>
            )}

            {onInsertCommand && others.length > 0 && (
              <Command.Group heading="Other Commands" className={groupClass}>
                {others.map((c) => renderCommand(c, 'other'))}
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
