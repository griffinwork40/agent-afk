import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { cn } from '@/lib/utils';
import {
  formatSlashCommandName,
  slashCommandMatchesQuery,
} from '@/lib/slash-command';
import type { SlashCommand } from '@/types/api';

// ── Recently-used persistence ──────────────────────────────────────────────

const RECENT_KEY = 'afk_slash_recent';
const RECENT_MAX = 5;

export function recordRecentCommand(name: string): void {
  try {
    const prev: string[] = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
    const next = [name, ...prev.filter((n) => n !== name)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // localStorage may be unavailable in some contexts.
  }
}

function readRecentCommands(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

// ── Core chat commands (pinned first in the palette) ──────────────────────

/** Commands always shown in the "Chat" group at the top of the palette. */
const CORE_COMMAND_NAMES = new Set([
  '/model', '/clear', '/compact', '/cost', '/rewind', '/fork',
  '/resume', '/help', '/exit',
]);

// ── Grouping helper ────────────────────────────────────────────────────────

interface CommandGroup {
  label: string;
  commands: SlashCommand[];
}

function buildGroups(
  commands: SlashCommand[],
  query: string,
  recentNames: string[],
  maxTotal = 12,
): CommandGroup[] {
  const q = query.trim().toLowerCase();
  const isFiltering = q.length > 0;

  if (isFiltering) {
    // While filtering, return a flat list (no groups) up to maxTotal.
    const matched = commands
      .filter((c) => slashCommandMatchesQuery(c.name, query))
      .slice(0, maxTotal);
    return matched.length > 0 ? [{ label: '', commands: matched }] : [];
  }

  // Un-filtered: Chat group → Recent group → Skills group.
  const coreGroup: SlashCommand[] = [];
  const recentGroup: SlashCommand[] = [];
  const skillsGroup: SlashCommand[] = [];
  const seen = new Set<string>();

  // 1. Chat (core) group — pinned first, in declaration order (max 7 to leave room for recent).
  const CORE_MAX = 7;
  for (const name of CORE_COMMAND_NAMES) {
    if (coreGroup.length >= CORE_MAX) break;
    const cmd = commands.find((c) => c.name === name);
    if (cmd) { coreGroup.push(cmd); seen.add(cmd.name); }
  }

  // 2. Recently used (from localStorage) — skip any already in core.
  for (const name of recentNames) {
    if (seen.has(name)) continue;
    const cmd = commands.find((c) => c.name === name);
    if (cmd) { recentGroup.push(cmd); seen.add(cmd.name); }
  }

  // 3. Remaining skills/native commands alphabetically.
  const rest = commands.filter((c) => !seen.has(c.name));
  skillsGroup.push(...rest);

  const groups: CommandGroup[] = [];
  if (coreGroup.length > 0) groups.push({ label: 'Chat', commands: coreGroup });
  if (recentGroup.length > 0) groups.push({ label: 'Recent', commands: recentGroup });
  if (skillsGroup.length > 0) groups.push({ label: 'Skills', commands: skillsGroup });

  // Enforce maxTotal across all groups.
  let remaining = maxTotal;
  return groups.map((g) => {
    const sliced = g.commands.slice(0, remaining);
    remaining = Math.max(0, remaining - sliced.length);
    return { ...g, commands: sliced };
  }).filter((g) => g.commands.length > 0);
}

// ── Component ──────────────────────────────────────────────────────────────

interface SlashAutocompleteProps {
  query: string;
  commands: SlashCommand[];
  onSelect: (name: string) => void;
  visible: boolean;
}

/** Dropdown for slash-command completion, positioned above the textarea. */
export function SlashAutocomplete({
  query,
  commands,
  onSelect,
  visible,
}: SlashAutocompleteProps) {
  const [activeIdx, setActiveIdx] = useState(0);
  const [recentNames, setRecentNames] = useState<string[]>([]);
  const listRef = useRef<HTMLUListElement>(null);

  // Refresh recently-used list whenever the autocomplete becomes visible.
  useEffect(() => {
    if (visible) setRecentNames(readRecentCommands());
  }, [visible]);

  const groups = buildGroups(commands, query, recentNames);
  // Flat list for keyboard navigation.
  const flat = groups.flatMap((g) => g.commands);

  // Reset selection when filter changes.
  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  // Scroll active item into view.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${activeIdx}"]`) as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  if (!visible || flat.length === 0) return null;

  return (
    <ul
      ref={listRef}
      role="listbox"
      aria-label="Slash commands"
      className={cn(
        'absolute bottom-full left-0 mb-1 w-full max-h-72 overflow-y-auto',
        'rounded-lg border border-border bg-popover shadow-lg z-50',
        'text-sm',
      )}
    >
      {groups.map((group) => (
        <li key={group.label || 'filtered'} role="presentation">
          {group.label && (
            <div className="px-3 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground select-none">
              {group.label}
            </div>
          )}
          <ul role="presentation">
            {group.commands.map((cmd) => {
              const globalIdx = flat.indexOf(cmd);
              const isActive = globalIdx === activeIdx;
              return (
                <li
                  key={cmd.name}
                  role="option"
                  aria-selected={isActive}
                  data-idx={globalIdx}
                  className={cn(
                    'flex items-baseline gap-2 px-3 py-2 cursor-pointer select-none',
                    isActive
                      ? 'bg-accent text-accent-foreground'
                      : 'hover:bg-accent/50',
                  )}
                  onMouseEnter={() => setActiveIdx(globalIdx)}
                  onMouseDown={(e) => {
                    e.preventDefault(); // keep textarea focus
                    onSelect(cmd.name);
                  }}
                >
                  <span className="font-mono font-semibold shrink-0">
                    {formatSlashCommandName(cmd.name)}
                  </span>
                  <span className="text-muted-foreground truncate">{cmd.summary}</span>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/**
 * Handle keyboard navigation within the autocomplete.
 * Returns true if the event was consumed (caller should preventDefault).
 */
export function handleAutocompleteKey(
  e: KeyboardEvent,
  visible: boolean,
  filteredCount: number,
  activeIdx: number,
  setActiveIdx: (i: number) => void,
  onConfirm: (idx: number) => void,
  onClose: () => void,
  activeIsExact = false,
): boolean {
  if (!visible || filteredCount === 0) return false;

  // Contract: Tab always completes. Enter completes only while the typed
  // token is a partial match; once it already equals the active suggestion
  // (e.g. the user typed `/help` in full), Enter falls through so the
  // composer submits, matching the REPL where Enter on a complete command runs it.
  if (e.key === 'Tab') {
    onConfirm(activeIdx);
    return true;
  }
  if (e.key === 'Enter' && activeIsExact) return false;

  if (e.key === 'ArrowDown') {
    setActiveIdx((activeIdx + 1) % filteredCount);
    return true;
  }
  if (e.key === 'ArrowUp') {
    setActiveIdx((activeIdx - 1 + filteredCount) % filteredCount);
    return true;
  }
  if (e.key === 'Enter') {
    onConfirm(activeIdx);
    return true;
  }
  if (e.key === 'Escape') {
    onClose();
    return true;
  }
  return false;
}
