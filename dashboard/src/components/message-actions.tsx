import { useState, useEffect, useRef } from 'react';
import { Check, Copy } from 'lucide-react';
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
 * TODO: add a timestamp display once the transcript items carry timestamp data.
 */
export function MessageActions({
  kind,
  text,
  className,
}: {
  kind: 'user' | 'assistant';
  text: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup copy timer on unmount to avoid setState on an unmounted component.
  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    };
  }, []);

  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    });
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
        {kind === 'assistant' && (
          <IconButton
            onClick={handleCopy}
            title={copied ? 'Copied!' : 'Copy'}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-status-running" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
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
  children,
}: {
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="h-6 w-6 rounded flex items-center justify-center hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
    >
      {children}
    </button>
  );
}
