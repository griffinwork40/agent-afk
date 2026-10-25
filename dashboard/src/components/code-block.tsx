import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { Copy, Check } from 'lucide-react';
import { highlight, preloadLang } from '@/lib/highlight';
import type { HighlightLine } from '@/lib/highlight';

// Contract: COLLAPSE_LINES is the threshold above which a "Show N more lines"
// toggle appears. The visible slice is always the first COLLAPSE_LINES lines;
// expand reveals the rest without re-highlighting.
const COLLAPSE_LINES = 25;

interface CodeBlockProps {
  code: string;
  language?: string;
}

// ---------------------------------------------------------------------------
// TokenLines — renders Shiki token lines as React spans (CSP-safe: no HTML
// injection, no dangerouslySetInnerHTML). React sets inline styles via CSSOM
// which is never blocked by style-src CSP directives.
// ---------------------------------------------------------------------------
function TokenLines({ lines, fg }: { lines: HighlightLine[]; fg: string }) {
  return (
    <>
      {lines.map((line, li) => (
        <span key={li} style={{ display: 'block', minHeight: '1.25rem' }}>
          {line.length === 0 ? '\n' : line.map((tok, ti) => (
            <span
              key={ti}
              style={{
                color: tok.color ?? fg,
                fontStyle: tok.fontStyle !== undefined && tok.fontStyle & 1 ? 'italic' : undefined,
                fontWeight: tok.fontStyle !== undefined && tok.fontStyle & 2 ? 'bold' : undefined,
                textDecoration: tok.fontStyle !== undefined && tok.fontStyle & 4 ? 'underline' : undefined,
              }}
            >
              {tok.content}
            </span>
          ))}
        </span>
      ))}
    </>
  );
}

export const CodeBlock = memo(function CodeBlock({ code, language }: CodeBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const lines = code.split('\n');
  const hiddenLines = Math.max(0, lines.length - COLLAPSE_LINES);
  const visibleCode = expanded ? code : lines.slice(0, COLLAPSE_LINES).join('\n');

  // Contract: tokenLines=null means "not yet highlighted" → render plaintext
  // fallback <pre> so the user sees content immediately. Once tokens arrive the
  // fallback is swapped for coloured spans without a layout shift.
  const [tokenResult, setTokenResult] = useState<{ lines: HighlightLine[]; bg: string; fg: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup copy timer on unmount.
  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      // Pre-warm the language grammar while we show the plaintext fallback.
      if (language) preloadLang(language);

      const result = await highlight(visibleCode, language);
      if (!cancelled) setTokenResult(result);
    }

    // Reset to plaintext fallback immediately so stale coloured tokens from a
    // prior code/language value are never shown during the async re-highlight.
    setTokenResult(null);
    run().catch(() => { /* leave null → plaintext fallback */ });

    return () => { cancelled = true; };
  }, [visibleCode, language]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    }).catch(() => { /* clipboard write failed silently */ });
  }, [code]);

  const bgColor = tokenResult?.bg ?? '#0d1117';

  return (
    <div className="relative group rounded-md overflow-hidden mb-2" style={{ backgroundColor: bgColor }}>
      {/* Header row: language label + copy button */}
      <div className="flex items-center justify-between px-3 pt-1.5 pb-0.5">
        {/* P1-9: explicit colour passes ≥4.5:1 on the Shiki github-dark bg
            (#24292e). Tailwind opacity tokens blend against the page bg, not
            the inline-style code bg, so axe's contrast check fails them — use
            a literal mid-grey (#9ba3ae) that is verifiably ≥4.5:1 on #24292e. */}
        <span className="text-[10px] select-none font-mono" style={{ color: '#9ba3ae' }}>
          {language ?? 'plaintext'}
        </span>
        <button
          onClick={handleCopy}
          aria-label="Copy code"
          className="opacity-100 focus-visible:outline-2 focus-visible:outline-ring transition-opacity rounded p-1 text-muted-foreground hover:text-foreground hover:bg-white/10"
        >
          {copied
            ? <Check size={13} strokeWidth={2.5} />
            : <Copy size={13} strokeWidth={2} />
          }
        </button>
      </div>

      {/* Code area */}
      <div className="relative">
        {tokenResult !== null ? (
          // Contract: token spans rendered via React — no dangerouslySetInnerHTML,
          // no <style> tags. React applies `style` props through CSSOM, which is
          // always permitted regardless of the style-src CSP directive.
          <div
            className="overflow-x-auto whitespace-pre p-3 font-mono text-xs leading-5"
            // Scrollable code regions must be keyboard-reachable (axe: scrollable-region-focusable).
            tabIndex={0}
            aria-label={language ? `${language} code block` : 'code block'}
            style={{ backgroundColor: bgColor }}
          >
            <TokenLines lines={tokenResult.lines} fg={tokenResult.fg} />
          </div>
        ) : (
          <pre
            className="overflow-x-auto p-3 font-mono text-xs leading-5 text-foreground"
            tabIndex={0}
            aria-label={language ? `${language} code block` : 'code block'}
          >
            <code>{visibleCode}</code>
          </pre>
        )}

        {/* Fade overlay hinting there are hidden lines */}
        {hiddenLines > 0 && !expanded && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-10"
            style={{ background: `linear-gradient(to top, ${bgColor}, transparent)` }}
          />
        )}
      </div>

      {/* Expand / collapse toggle */}
      {hiddenLines > 0 && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(v => !v)}
          className="w-full py-2 text-xs text-foreground hover:bg-white/5 rounded focus-visible:outline-2 focus-visible:outline-ring"
        >
          {expanded ? 'Show less' : `Show ${hiddenLines} more lines`}
        </button>
      )}
    </div>
  );
});
