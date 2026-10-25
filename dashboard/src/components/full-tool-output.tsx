/**
 * Tool-output body with on-demand loading of the full result.
 *
 * Renders the preview the ledger already carried, plus a "Load full output"
 * control when the preview is clipped or missing. Clicking it fetches the
 * complete result from the message journal (see use-full-tool-result.ts) and
 * replaces the preview in place.
 */

import { useState } from 'react';
import { useFullToolResult } from '@/hooks/use-full-tool-result';

interface FullToolOutputProps {
  toolUseId?: string;
  /** Preview text from the ledger (possibly clipped), if any. */
  preview?: string;
  /** True when `preview` is known to be clipped. */
  clipped?: boolean;
  /** True when the ledger carried no output at all for this call. */
  unavailable?: boolean;
}

const PRE_CLASS = 'overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-foreground';

function OutputText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const lines = text.split('\n');
  const hiddenLines = Math.max(0, lines.length - 25);
  return <div>
    <button type="button" onClick={() => { void navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(() => setCopied(false)); }} className="mb-1 text-xs text-foreground rounded focus-visible:outline-2 focus-visible:outline-ring">{copied ? 'Copied output' : 'Copy output'}</button>
    <div className="relative">
      <pre className={PRE_CLASS}>{expanded ? text : lines.slice(0, 25).join('\n')}</pre>
      {hiddenLines > 0 && !expanded && <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-card to-transparent" />}
    </div>
    {hiddenLines > 0 && <button type="button" aria-expanded={expanded} onClick={() => setExpanded(v => !v)} className="w-full py-2 text-xs text-foreground rounded focus-visible:outline-2 focus-visible:outline-ring">{expanded ? 'Show less' : `Show ${hiddenLines} more lines`}</button>}
  </div>;
}

export function FullToolOutput({ toolUseId, preview, clipped, unavailable }: FullToolOutputProps) {
  const { state, canLoad, load } = useFullToolResult(toolUseId);

  if (state.status === 'loaded') {
    const { result } = state;
    return (
      <div>
        <OutputText text={result.text} />
        {result.truncated && (
          <p className="mt-1 text-[11px] italic text-muted-foreground">
            Showing the first {result.text.length.toLocaleString()} of{' '}
            {result.totalChars.toLocaleString()} characters.
          </p>
        )}
      </div>
    );
  }

  const offerLoad = canLoad && (clipped === true || unavailable === true);

  return (
    <div>
      {unavailable && !preview && (
        <p className="text-[11px] italic text-muted-foreground">
          Output not in the live record (replayed session)
        </p>
      )}
      {preview && <OutputText text={preview} />}
      {offerLoad && (
        <button
          type="button"
          onClick={load}
          disabled={state.status === 'loading'}
          className="mt-1 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50"
        >
          {state.status === 'loading' ? 'Loading full output…' : 'Load full output'}
        </button>
      )}
      {state.status === 'error' && (
        <p className="mt-1 text-[11px] italic text-status-failed">{state.message}</p>
      )}
    </div>
  );
}
