/**
 * Renders a command-output transcript item.
 *
 * Command-output items are CLIENT-LOCAL — they are never persisted to the
 * session journal or SSE stream. They live only in the React tree for the
 * duration of the browser session (A7).
 *
 * Each item contains one or more `CommandOutputBlock` entries from the
 * `POST /api/sessions/:id/commands` response. Blocks are rendered via the
 * block-renderer registry; unknown kinds fall back to the plain-text field.
 */

import { useState, type ReactElement } from 'react';
import { Copy, Check } from 'lucide-react';
import { getBlockRenderer } from '@/lib/block-renderer-registry';
import type { CommandOutputBlock } from '@/types/command-wire';
import { cn } from '@/lib/utils';

interface CommandOutputProps {
  /** The input that triggered this command (e.g. "/help"). */
  input: string;
  /** Output blocks from the command handler. */
  blocks: CommandOutputBlock[];
}

export function CommandOutput({ input, blocks }: CommandOutputProps): ReactElement {
  const [copied, setCopied] = useState(false);

  const plainText = blocks.map((b) => b.text).join('\n');

  const handleCopy = () => {
    void navigator.clipboard.writeText(plainText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      className={cn(
        'rounded-lg border border-border/50 bg-muted/20',
        'text-sm font-mono',
        'overflow-hidden',
      )}
      role="region"
      aria-label={`Output for ${input}`}
    >
      {/* Header bar: command echo + copy button */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/40 bg-muted/40 select-none">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
          <span className="text-primary/70" aria-hidden="true">❯</span>
          <span className="truncate font-medium">{input}</span>
        </span>
        <button
          type="button"
          onClick={handleCopy}
          title="Copy output"
          aria-label="Copy command output"
          className={cn(
            'ml-2 shrink-0 flex items-center gap-1 rounded px-1.5 py-0.5 text-xs',
            'text-muted-foreground hover:text-foreground hover:bg-accent transition-colors',
            'focus:outline-none focus:ring-1 focus:ring-ring',
          )}
        >
          {copied
            ? <Check className="h-3 w-3 text-status-done" aria-hidden="true" />
            : <Copy className="h-3 w-3" aria-hidden="true" />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      {/* Output blocks */}
      <div className="min-w-0 px-3 py-2 flex flex-col gap-2 break-words leading-snug">
        {blocks.map((block, i) => {
          const renderer = getBlockRenderer(block.kind ?? 'text');
          try {
            return <div key={i} className="min-w-0 whitespace-pre-wrap">{renderer(block)}</div>;
          } catch {
            return <div key={i} className="whitespace-pre-wrap">{block.text}</div>;
          }
        })}
      </div>
    </div>
  );
}
