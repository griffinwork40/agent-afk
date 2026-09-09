/**
 * @file context injection affordance for the React composer.
 *
 * Renders an '@' button that opens a popover where the user can type a file
 * path. On submit, the callback fires with the `@<path>` token so the parent
 * Composer can insert it at the cursor position.
 *
 * Port of src/web-server/frontend/at-file-panel.ts to React + Tailwind.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText } from 'lucide-react';
import { cn } from '@/lib/utils';

interface AtFilePopoverProps {
  /** Called with the full `@path` token string to insert into the composer. */
  onInsert: (token: string) => void;
}

/**
 * Contract: path must be non-empty and start with /, ./, ~/, or contain no
 * leading slash (relative bare path like src/file.ts). Matches the validation
 * in the old at-file-panel.ts.
 */
function looksLikePath(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  return s.startsWith('/') || s.startsWith('./') || s.startsWith('~/') || /^[\w.]/.test(s);
}

export function AtFilePopover({ onInsert }: AtFilePopoverProps) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState('');
  const [error, setError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setError(false);
    setPath('');
  }, []);

  const commit = useCallback(() => {
    const trimmed = path.trim();
    if (!looksLikePath(trimmed)) {
      setError(true);
      inputRef.current?.focus();
      return;
    }
    onInsert(`@${trimmed}`);
    close();
  }, [path, onInsert, close]);

  // Focus input when popover opens.
  useEffect(() => {
    if (open) {
      // Defer to next frame so the input is mounted.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Dismiss on click outside.
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (
        popoverRef.current &&
        !popoverRef.current.contains(target) &&
        buttonRef.current &&
        !buttonRef.current.contains(target)
      ) {
        close();
      }
    }
    document.addEventListener('click', handleClick, { capture: true });
    return () => document.removeEventListener('click', handleClick, { capture: true });
  }, [open, close]);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-label="Insert file reference"
        aria-expanded={open}
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-md text-sm',
          'transition-colors hover:bg-accent hover:text-accent-foreground',
          open && 'bg-accent text-accent-foreground',
        )}
        title="Insert @file reference"
      >
        <FileText className="h-4 w-4" />
      </button>

      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Insert file path"
          className={cn(
            'absolute bottom-full left-0 mb-2 w-72 rounded-lg border',
            'bg-popover p-3 shadow-lg animate-fade-in',
          )}
        >
          <p className="mb-2 text-xs text-muted-foreground">
            Type a file path. <code className="text-[10px]">@~/file.ts</code> or{' '}
            <code className="text-[10px]">@src/file.ts</code>
          </p>

          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={path}
              onChange={(e) => {
                setPath(e.target.value);
                setError(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commit();
                }
                if (e.key === 'Escape') close();
              }}
              placeholder="src/foo.ts or ~/file.ts"
              autoComplete="off"
              spellCheck={false}
              className={cn(
                'flex-1 rounded-md border bg-secondary px-2 py-1 text-sm',
                'placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring',
                error && 'border-destructive',
              )}
            />
            <button
              type="button"
              onClick={commit}
              className={cn(
                'rounded-md bg-primary px-3 py-1 text-sm font-medium',
                'text-primary-foreground hover:bg-primary/90',
              )}
            >
              Add
            </button>
          </div>

          {error && (
            <p className="mt-1 text-xs text-destructive">Enter a valid file path.</p>
          )}
        </div>
      )}
    </div>
  );
}
