import { useState, useEffect, useRef } from 'react';
import { Check, Copy, Pencil, RotateCcw, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// MessageActions
// ---------------------------------------------------------------------------

/**
 * Hover-revealed action bar positioned at the top-right of a message row.
 *
 * The parent row must carry the `group relative` Tailwind classes so that
 * `group-hover:opacity-100` fires correctly and absolute positioning is
 * scoped to the row.
 *
 * Actions available per kind:
 *   user      — Copy, Edit-and-resend (when onEdit provided), timestamp
 *   assistant — Copy, Retry/regenerate (when onRetry provided), timestamp
 *
 * Retry and Edit are disabled while isBusy is true.
 */
export function MessageActions({
  kind,
  text,
  ts,
  className,
  onRetry,
  onEdit,
  isBusy,
}: {
  kind: 'user' | 'assistant';
  text: string;
  ts?: number;
  className?: string;
  /** Assistant only: regenerate the last assistant turn. */
  onRetry?: () => void;
  /** User only: edit this message and resend. */
  onEdit?: (text: string) => void;
  /** When true, retry/edit buttons are disabled. */
  isBusy?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(text);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);

  // Sync edit value if text prop changes (e.g. after rewind).
  useEffect(() => { setEditValue(text); }, [text]);

  // Cleanup copy timer on unmount.
  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    };
  }, []);

  // Focus edit textarea when editing starts.
  useEffect(() => {
    if (editing) {
      const ta = editRef.current;
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    }
  }, [editing]);

  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }

  function handleEditCommit() {
    const trimmed = editValue.trim();
    setEditing(false);
    if (trimmed && trimmed !== text) onEdit?.(trimmed);
  }

  function handleEditKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEditCommit(); }
    if (e.key === 'Escape') { setEditing(false); setEditValue(text); }
  }

  const timestamp = ts !== undefined ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : undefined;

  if (editing) {
    return (
      <div className="mt-1 flex w-full max-w-2xl flex-col gap-1">
        <textarea
          ref={editRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleEditKeyDown}
          rows={Math.min(8, editValue.split('\n').length + 1)}
          className={cn(
            'w-full resize-none rounded-lg border border-ring bg-background',
            'px-3 py-2 text-sm leading-5 shadow-sm',
            'focus:outline-none focus:ring-2 focus:ring-ring',
          )}
        />
        <div className="flex gap-1.5 justify-end">
          <button
            type="button"
            onClick={() => { setEditing(false); setEditValue(text); }}
            className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground border border-border hover:bg-secondary transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleEditCommit}
            disabled={!editValue.trim() || isBusy}
            className={cn(
              'rounded px-2 py-0.5 text-xs font-medium',
              'bg-primary text-primary-foreground hover:bg-primary/90 transition-colors',
              'disabled:opacity-40 disabled:cursor-not-allowed',
            )}
          >
            Send
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'absolute top-1 right-1',
        'opacity-0 group-hover:opacity-100 transition-opacity duration-150',
        className,
      )}
    >
      <div className="flex items-center gap-0.5 rounded-md border border-border bg-card px-1 py-0.5 shadow-sm">
        {/* Timestamp on hover */}
        {timestamp && (
          <span
            className="flex items-center gap-0.5 px-1 text-[10px] text-muted-foreground/70"
            title={ts !== undefined ? new Date(ts).toLocaleString() : undefined}
          >
            <Clock className="h-2.5 w-2.5" />
            {timestamp}
          </span>
        )}

        {/* Copy — available for both user and assistant */}
        <IconButton onClick={handleCopy} title={copied ? 'Copied!' : 'Copy'}>
          {copied ? (
            <Check className="h-3.5 w-3.5 text-status-running" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </IconButton>

        {/* Retry — assistant messages only */}
        {kind === 'assistant' && onRetry && (
          <IconButton
            onClick={onRetry}
            title={isBusy ? 'Stop the turn before retrying' : 'Retry'}
            disabled={isBusy}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </IconButton>
        )}

        {/* Edit-and-resend — user messages only */}
        {kind === 'user' && onEdit && (
          <IconButton
            onClick={() => setEditing(true)}
            title={isBusy ? 'Stop the turn before editing' : 'Edit and resend'}
            disabled={isBusy}
          >
            <Pencil className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// IconButton (internal helper)
// ---------------------------------------------------------------------------

function IconButton({
  onClick,
  title,
  disabled,
  children,
}: {
  onClick: () => void;
  title?: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={cn(
        'h-6 w-6 rounded flex items-center justify-center',
        'hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors',
        disabled && 'opacity-40 cursor-not-allowed',
      )}
    >
      {children}
    </button>
  );
}
