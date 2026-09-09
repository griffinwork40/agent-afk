/**
 * Mid-run message queue panel for the React dashboard.
 *
 * Renders queued prompts above the composer with reorder (up/down), inline
 * edit, and remove controls. Each row shows a truncated preview of the queued
 * text with action buttons.
 *
 * Port of src/web-server/frontend/queue-panel.ts to React + Tailwind.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, ArrowDown, Pencil, X, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { UseQueueResult } from '@/hooks/use-queue';

interface QueuePanelProps {
  queue: UseQueueResult;
}

export function QueuePanel({ queue }: QueuePanelProps) {
  const { entries, moveItemUp, moveItemDown, removeItem, editItem } = queue;

  if (entries.length === 0) return null;

  return (
    <div className="flex flex-col gap-1 border-b border-border/50 px-3 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Queued ({entries.length})
      </p>
      {entries.map((text, i) => (
        <QueueRow
          key={`${i}-${text.slice(0, 20)}`}
          text={text}
          index={i}
          isFirst={i === 0}
          isLast={i === entries.length - 1}
          onMoveUp={() => moveItemUp(i)}
          onMoveDown={() => moveItemDown(i)}
          onRemove={() => removeItem(i)}
          onEdit={(value) => editItem(i, value)}
        />
      ))}
    </div>
  );
}

// ---- QueueRow ---------------------------------------------------------------

interface QueueRowProps {
  text: string;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  onEdit: (value: string) => void;
}

function QueueRow({
  text,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
  onRemove,
  onEdit,
}: QueueRowProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(text);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const startEdit = useCallback(() => {
    setEditValue(text);
    setEditing(true);
  }, [text]);

  const commitEdit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== text) {
      onEdit(trimmed);
    }
    setEditing(false);
  }, [editValue, text, onEdit]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setEditValue(text);
  }, [text]);

  return (
    <div
      className={cn(
        'group flex items-center gap-1.5 rounded-md border border-border/50',
        'bg-secondary/50 px-2 py-1 text-sm animate-fade-in',
      )}
    >
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitEdit();
            if (e.key === 'Escape') cancelEdit();
          }}
          onBlur={commitEdit}
          className={cn(
            'min-w-0 flex-1 bg-transparent text-sm',
            'focus:outline-none',
          )}
        />
      ) : (
        <span className="min-w-0 flex-1 truncate text-foreground/80">{text}</span>
      )}

      <div className="flex shrink-0 items-center gap-0.5 opacity-60 group-hover:opacity-100">
        {editing ? (
          <QueueButton label="Confirm edit" onClick={commitEdit}>
            <Check className="h-3 w-3" />
          </QueueButton>
        ) : (
          <QueueButton label="Edit" onClick={startEdit}>
            <Pencil className="h-3 w-3" />
          </QueueButton>
        )}
        <QueueButton label="Move up" onClick={onMoveUp} disabled={isFirst}>
          <ArrowUp className="h-3 w-3" />
        </QueueButton>
        <QueueButton label="Move down" onClick={onMoveDown} disabled={isLast}>
          <ArrowDown className="h-3 w-3" />
        </QueueButton>
        <QueueButton label="Remove" onClick={onRemove} destructive>
          <X className="h-3 w-3" />
        </QueueButton>
      </div>
    </div>
  );
}

// ---- tiny button helper -----------------------------------------------------

function QueueButton({
  label,
  onClick,
  disabled,
  destructive,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        'flex h-5 w-5 items-center justify-center rounded',
        'transition-colors',
        disabled
          ? 'cursor-not-allowed opacity-30'
          : destructive
            ? 'hover:bg-destructive/20 hover:text-destructive'
            : 'hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {children}
    </button>
  );
}
