import { useState, useEffect, useRef, useCallback } from 'react';
import { Copy, Check } from 'lucide-react';
import type { Highlighter } from 'shiki';

// Contract: highlighterRef holds a singleton promise so multiple CodeBlock mounts
// never race to create separate Highlighter instances. The ref is module-scope to
// survive component unmounts while the page is still active.
let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then(({ createHighlighter }) =>
      createHighlighter({
        themes: ['github-dark'],
        langs: [
          'typescript', 'javascript', 'tsx', 'jsx',
          'json', 'bash', 'sh', 'python', 'rust',
          'css', 'html', 'markdown', 'yaml', 'toml',
          'sql', 'go', 'java', 'c', 'cpp', 'ruby',
        ],
      })
    );
  }
  return highlighterPromise;
}

interface CodeBlockProps {
  code: string;
  language?: string;
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    getHighlighter().then((highlighter) => {
      if (cancelled) return;

      // Resolve to a supported language or fall back to plain text.
      const supportedLangs = highlighter.getLoadedLanguages();
      const lang = language && supportedLangs.includes(language as Parameters<typeof highlighter.codeToHtml>[1]['lang'])
        ? (language as Parameters<typeof highlighter.codeToHtml>[1]['lang'])
        : 'text';

      try {
        const highlighted = highlighter.codeToHtml(code, {
          lang,
          theme: 'github-dark',
        });
        if (!cancelled) setHtml(highlighted);
      } catch {
        // Highlighting failed — leave html null so the fallback <pre> renders.
      }
    }).catch(() => {
      // Highlighter load failed — fallback stays visible.
    });

    return () => { cancelled = true; };
  }, [code, language]);

  // Cleanup copy timer on unmount.
  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      // Clipboard write failed silently — no UI change.
    });
  }, [code]);

  return (
    <div className="relative group rounded-md bg-secondary overflow-hidden mb-2">
      {/* Language label */}
      {language && (
        <div className="text-[10px] text-muted-foreground px-3 pt-1.5 select-none">
          {language}
        </div>
      )}

      {/* Copy button — revealed on group hover */}
      <button
        onClick={handleCopy}
        aria-label="Copy code"
        className="absolute top-1.5 right-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity rounded p-1 text-muted-foreground hover:text-foreground hover:bg-white/10"
      >
        {copied
          ? <Check size={13} strokeWidth={2.5} />
          : <Copy size={13} strokeWidth={2} />
        }
      </button>

      {/* Highlighted HTML or fallback */}
      {html !== null ? (
        <div
          className="overflow-x-auto text-xs leading-5 [&>pre]:p-3 [&>pre]:m-0 [&>pre]:bg-transparent! [&>pre]:font-mono"
          // Contract: html comes exclusively from shiki's codeToHtml — it never
          // contains user-supplied content verbatim (code is syntax-tokenised).
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="overflow-x-auto p-3 font-mono text-xs leading-5 text-foreground">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
