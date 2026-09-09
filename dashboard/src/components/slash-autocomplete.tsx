import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { cn } from '@/lib/utils';
import type { SlashCommand } from '@/types/api';

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
  const listRef = useRef<HTMLUListElement>(null);

  const filtered = commands
    .filter((c) => c.name.startsWith(query))
    .slice(0, 8);

  // Reset selection when filter changes
  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current?.children[activeIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  if (!visible || filtered.length === 0) return null;

  return (
    <ul
      ref={listRef}
      role="listbox"
      aria-label="Slash commands"
      className={cn(
        'absolute bottom-full left-0 mb-1 w-full max-h-56 overflow-y-auto',
        'rounded-lg border border-border bg-popover shadow-lg z-50',
        'text-sm',
      )}
    >
      {filtered.map((cmd, i) => (
        <li
          key={cmd.name}
          role="option"
          aria-selected={i === activeIdx}
          className={cn(
            'flex items-baseline gap-2 px-3 py-2 cursor-pointer select-none',
            i === activeIdx
              ? 'bg-accent text-accent-foreground'
              : 'hover:bg-accent/50',
          )}
          onMouseEnter={() => setActiveIdx(i)}
          onMouseDown={(e) => {
            e.preventDefault(); // keep textarea focus
            onSelect(cmd.name);
          }}
        >
          <span className="font-mono font-semibold shrink-0">/{cmd.name}</span>
          <span className="text-muted-foreground truncate">{cmd.summary}</span>
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
): boolean {
  if (!visible || filteredCount === 0) return false;

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
