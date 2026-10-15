/**
 * Tool-output body with on-demand loading of the full result.
 *
 * Renders the preview the ledger already carried, plus a "Load full output"
 * control when the preview is clipped or missing. Clicking it fetches the
 * complete result from the message journal (see use-full-tool-result.ts) and
 * replaces the preview in place.
 */

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

export function FullToolOutput({ toolUseId, preview, clipped, unavailable }: FullToolOutputProps) {
  const { state, canLoad, load } = useFullToolResult(toolUseId);

  if (state.status === 'loaded') {
    const { result } = state;
    return (
      <div>
        <pre className={PRE_CLASS}>{result.text}</pre>
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
      {preview && <pre className={PRE_CLASS}>{preview}</pre>}
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
