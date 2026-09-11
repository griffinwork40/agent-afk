import { useState, useEffect, useRef, useCallback } from 'react';
import { MarkdownContent } from './markdown-content';

// Contract: cursor blink uses step-end so the transition is instantaneous
// (on/off) rather than a fade, matching terminal cursor behaviour.
const BLINK_STYLE = `
@keyframes blink-cursor {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0; }
}
.streaming-cursor {
  display: inline-block;
  width: 0.125rem;    /* w-0.5 */
  height: 1.1em;
  background: var(--color-brand, #6366f1);
  vertical-align: text-bottom;
  animation: blink-cursor 530ms step-end infinite;
}
`;

/** A blinking vertical-bar cursor. Renders nothing when not needed. */
export function StreamingCursor() {
  return (
    <>
      <style>{BLINK_STYLE}</style>
      <span className="streaming-cursor" aria-hidden="true" />
    </>
  );
}

// Contract: CODE_FENCE_RE matches either ``` or ~~~~ at the start of a line
// (possibly preceded by spaces). Used to detect partial fence markers.
const CODE_FENCE_RE = /^[ \t]*(`{3,}|~{4,})/;

/**
 * Returns an adjusted display length that never cuts off inside a code-fence
 * marker. If the slice [0, rawLen] would land mid-line and that partial line
 * starts a code fence, we extend to the end of that line so the fence is never
 * partially visible.
 */
function fenceSafeLength(text: string, rawLen: number): number {
  if (rawLen >= text.length) return rawLen;

  // Find the start of the current (partial) line.
  const lineStart = text.lastIndexOf('\n', rawLen - 1) + 1; // 0 if no newline
  const partialLine = text.slice(lineStart, rawLen);

  if (CODE_FENCE_RE.test(partialLine)) {
    // Extend to the end of this line (or end of text).
    const lineEnd = text.indexOf('\n', rawLen);
    return lineEnd === -1 ? text.length : lineEnd + 1;
  }

  return rawLen;
}

export interface StreamingTextProps {
  text: string;
  isStreaming: boolean;
  /** Characters per second. Defaults to 80. */
  speed?: number;
  onComplete?: () => void;
}

/**
 * Renders text character-by-character via rAF, then delegates to
 * `<MarkdownContent>` for the visible slice. Shows a blinking cursor while
 * text is still arriving or the animation hasn't caught up.
 *
 * Invariant: `displayedLength` only ever increases — never resets mid-stream.
 * Invariant: rAF loop is the ONLY writer of `displayedLengthRef`; React state
 *   is updated at most once per ~16ms frame to avoid excessive re-renders.
 * Invariant: `cancelAnimationFrame` is called on unmount via the cleanup
 *   returned by the useEffect that owns the loop.
 */
export function StreamingText({
  text,
  isStreaming,
  speed = 80,
  onComplete,
}: StreamingTextProps) {
  // Displayed slice length tracked in ref (written every frame) + state
  // (drives re-render). We only call setState when the value actually changes
  // so React batches naturally around 16ms frame boundaries.
  const displayedLengthRef = useRef(0);
  const [displayedLength, setDisplayedLength] = useState(0);

  // rAF handle — stored in ref so cleanup can reach it.
  const rafRef = useRef<number | null>(null);

  // Last timestamp from rAF, used to compute per-frame character advance.
  const lastTimestampRef = useRef<number | null>(null);

  // Whether onComplete has already been called for this message.
  const completedRef = useRef(false);

  // Stable callback so useEffect deps don't change on every render.
  const onCompleteRef = useRef(onComplete);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);

  // Edge case: if the component mounts with text already present and streaming
  // is already false (e.g. a replayed/historical message), skip animation and
  // show the full text immediately.
  const skipAnimation = !isStreaming && displayedLengthRef.current === 0 && text.length > 0;

  const startLoop = useCallback(() => {
    // Don't double-schedule.
    if (rafRef.current !== null) return;

    function tick(timestamp: number) {
      const last = lastTimestampRef.current ?? timestamp;
      const elapsed = timestamp - last;
      lastTimestampRef.current = timestamp;

      const charsPerMs = speed / 1000;
      const advance = Math.max(1, Math.floor(charsPerMs * elapsed));

      const currentLen = displayedLengthRef.current;
      const targetLen = text.length; // captured via closure — latest prop value

      if (currentLen < targetLen) {
        const rawNext = Math.min(currentLen + advance, targetLen);
        const next = fenceSafeLength(text, rawNext);
        displayedLengthRef.current = next;
        setDisplayedLength(next);
      }

      const caught = displayedLengthRef.current >= text.length;

      if (caught && !isStreaming) {
        // Animation complete.
        rafRef.current = null;
        lastTimestampRef.current = null;
        if (!completedRef.current) {
          completedRef.current = true;
          onCompleteRef.current?.();
        }
        return; // stop loop
      }

      // Continue — either still catching up or isStreaming (more text may arrive).
      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
  }, [speed, text, isStreaming]);

  useEffect(() => {
    // Fast path: historical/replayed message — render full text immediately.
    if (skipAnimation) {
      displayedLengthRef.current = text.length;
      setDisplayedLength(text.length);
      if (!completedRef.current) {
        completedRef.current = true;
        onCompleteRef.current?.();
      }
      return;
    }

    // If there's new text to animate (either new streaming tokens or initial
    // mount with partial text), kick off the rAF loop.
    if (displayedLengthRef.current < text.length || isStreaming) {
      startLoop();
    }

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  // Re-run when text grows (streaming tokens) or streaming flips off.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, isStreaming, skipAnimation]);

  // Determine what to show.
  const effectiveLength = skipAnimation ? text.length : displayedLength;
  const visibleText = text.slice(0, effectiveLength);
  const showCursor = effectiveLength < text.length || isStreaming;

  return (
    <span className="streaming-text-root">
      <MarkdownContent text={visibleText} />
      {showCursor && <StreamingCursor />}
    </span>
  );
}
