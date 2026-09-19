import { useState, useEffect, useRef, useCallback } from 'react';
import { Copy, Check } from 'lucide-react';
import type { Highlighter } from 'shiki';

// Contract: highlighterPromise is a module-scope singleton so multiple CodeBlock
// mounts never race to create separate Highlighter instances. Initialized with
// only 'plaintext' — individual grammars are loaded on-demand via loadLanguage().
let highlighterPromise: Promise<Highlighter> | null = null;

// Contract: langLoadPromises tracks in-flight and completed per-language loads.
// Keys are the raw language strings requested by callers. A resolved entry means
// the grammar is in the highlighter; a rejected entry means it failed (treat as
// unknown). Module-scope so every CodeBlock shares the same load state.
const langLoadPromises = new Map<string, Promise<void>>();

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then(({ createHighlighter }) =>
      createHighlighter({
        themes: ['github-dark'],
        // Only plaintext to start — other grammars load on-demand below.
        langs: ['plaintext'],
      })
    );
  }
  return highlighterPromise;
}

// Load a language grammar into the shared highlighter on demand.
// Returns a promise that resolves when the grammar is ready (idempotent — safe
// to call many times for the same language). Falls back to plaintext on failure.
function ensureLanguageLoaded(lang: string): Promise<void> {
  const existing = langLoadPromises.get(lang);
  if (existing) return existing;

  const p = import('shiki').then(async ({ bundledLanguages, isSpecialLang }) => {
    // Special langs (plaintext, ansi, …) are always available — nothing to load.
    if (isSpecialLang(lang)) return;

    // Only attempt to load langs that shiki ships a grammar for.
    const factory = (bundledLanguages as Record<string, (() => Promise<unknown>) | undefined>)[lang];
    if (!factory) throw new Error(`unknown lang: ${lang}`);

    const hl = await getHighlighter();
    // Guard: another mount may have already loaded this lang between the Map
    // check above and the await on getHighlighter().
    if (hl.getLoadedLanguages().includes(lang)) return;
    await hl.loadLanguage(factory as Parameters<typeof hl.loadLanguage>[0]);
  }).catch((err) => {
    // Evict failed entry so a retry is possible on next mount (e.g. after a
    // transient chunk-load failure). Without this, the rejected promise stays
    // cached and the language is permanently broken until page reload.
    langLoadPromises.delete(lang);
    throw err;
  });

  langLoadPromises.set(lang, p);
  return p;
}

interface CodeBlockProps {
  code: string;
  language?: string;
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [reHighlightTick, setReHighlightTick] = useState(0);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function highlight() {
      const hl = await getHighlighter();
      if (cancelled) return;

      // Resolve language: attempt on-demand load if the lang was requested and
      // is not yet loaded. While loading, fall through to plaintext immediately
      // so the user sees highlighted output right away; once the grammar loads,
      // reHighlightTick increments to re-run this effect with the real grammar.
      let resolvedLang: string = 'plaintext';
      if (language) {
        // Check special langs first — shiki's getLoadedLanguages() does NOT
        // include built-in special langs (plaintext, ansi, text, txt) even
        // after init, so we must check isSpecialLang before the loaded list.
        const { isSpecialLang } = await import('shiki');
        const loadedLangs = hl.getLoadedLanguages();
        if (isSpecialLang(language) || loadedLangs.includes(language)) {
          resolvedLang = language;
        } else {
          // Kick off load (idempotent). On completion, bump the tick counter
          // to re-run this effect — the grammar will be in the highlighter.
          ensureLanguageLoaded(language)
            .then(() => {
              if (!cancelled) setReHighlightTick((t) => t + 1);
            })
            .catch(() => {
              // Unknown or failed lang — plaintext fallback stays.
            });
          // Render immediately with plaintext while the grammar is in flight.
          resolvedLang = 'plaintext';
        }
      }

      try {
        const highlighted = hl.codeToHtml(code, {
          lang: resolvedLang,
          theme: 'github-dark',
        });
        if (!cancelled) setHtml(highlighted);
      } catch {
        // Highlighting failed — leave html null so the fallback <pre> renders.
      }
    }

    // Setting html to null triggers the plaintext fallback immediately while
    // the async highlight runs; avoids showing stale HTML from a prior render.
    setHtml(null);
    highlight().catch(() => {
      // Highlighter load failed — fallback stays visible.
    });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reHighlightTick is
  // an intentional re-trigger for when an on-demand grammar finishes loading.
  }, [code, language, reHighlightTick]);

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
