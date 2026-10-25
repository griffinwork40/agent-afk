import { MarkdownContent } from './markdown-content';

/** A blinking vertical-bar cursor. Renders nothing when not needed. */
export function StreamingCursor() {
  return <span className="streaming-cursor" aria-hidden="true" />;
}

// Contract: CODE_FENCE_RE matches either ``` or ~~~~ at the start of a line
// (possibly preceded by spaces). Used to detect partial fence markers.
const CODE_FENCE_RE = /^[ \t]*(`{3,}|~{4,})/;

/**
 * Length of `text` that is safe to render while more text may still arrive:
 * if the trailing (unterminated) line is a code-fence marker, it is held back
 * until its newline arrives, so a half-typed ``` ``` ``` info string never
 * flashes as a fence that then changes language.
 */
export function fenceSafeLength(text: string): number {
  const lineStart = text.lastIndexOf('\n') + 1;
  if (lineStart >= text.length) return text.length;
  return CODE_FENCE_RE.test(text.slice(lineStart)) ? lineStart : text.length;
}

export interface StreamingTextProps {
  text: string;
  isStreaming: boolean;
}

/**
 * Renders text as it arrives from the server (no client-side typewriter): the
 * live draft's buffered text, with a cursor while it is still streaming.
 * Durable/historical text (`isStreaming` false) renders whole and immediately.
 */
export function StreamingText({ text, isStreaming }: StreamingTextProps) {
  const visibleText = isStreaming ? text.slice(0, fenceSafeLength(text)) : text;
  return (
    <span className="streaming-text-root">
      <MarkdownContent text={visibleText} />
      {isStreaming && <StreamingCursor />}
    </span>
  );
}
