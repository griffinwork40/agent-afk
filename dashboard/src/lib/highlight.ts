/**
 * CSP-safe syntax highlighting via Shiki's JavaScript regex engine.
 *
 * Contract: we NEVER use codeToHtml / dangerouslySetInnerHTML because the
 * resulting <style> tags and inline `style` attributes produced by Shiki's HTML
 * serializer are blocked by the server's strict CSP
 * ("script-src 'self'; style-src 'self'"). Instead we use codeToTokens and
 * let React render each token as a <span style={…}> — React applies styles via
 * the CSSOM which is always allowed regardless of CSP.
 *
 * Contract: we use createJavaScriptRegexEngine (no WASM) so the highlighter
 * works under a strict CSP that blocks wasm-unsafe-eval. The JS engine has
 * slightly lower fidelity than the WASM engine for pathological grammars but
 * produces correct colours for all common languages (Rust, TS, Python, etc.).
 *
 * Contract: the highlighter is a module-scope singleton. Multiple CodeBlock
 * mounts share one instance; individual language grammars are loaded on-demand.
 */

import type { ThemedToken, BundledLanguage, SpecialLanguage } from 'shiki';

export type HighlightLine = ThemedToken[];

export interface HighlightResult {
  lines: HighlightLine[];
  bg: string;
  fg: string;
}

// Module-scope singleton promise — never recreated after first call.
let _hlPromise: Promise<import('shiki').Highlighter> | null = null;

// Per-language load promises — idempotent, keyed by canonical lang name.
const _langPromises = new Map<string, Promise<void>>();

function getHighlighter(): Promise<import('shiki').Highlighter> {
  if (!_hlPromise) {
    _hlPromise = (async () => {
      const { createHighlighter, createJavaScriptRegexEngine } = await import('shiki');
      return createHighlighter({
        themes: ['github-dark'],
        langs: ['plaintext'],
        engine: createJavaScriptRegexEngine(),
      });
    })();
  }
  return _hlPromise;
}

async function ensureLang(lang: string): Promise<void> {
  const existing = _langPromises.get(lang);
  if (existing) return existing;

  const p = (async () => {
    const { isSpecialLang, bundledLanguages } = await import('shiki');
    if (isSpecialLang(lang)) return;

    const factory = (bundledLanguages as Record<string, (() => Promise<unknown>) | undefined>)[lang];
    if (!factory) throw new Error(`shiki: unknown lang "${lang}"`);

    const hl = await getHighlighter();
    if (hl.getLoadedLanguages().includes(lang)) return;
    await hl.loadLanguage(factory as Parameters<typeof hl.loadLanguage>[0]);
  })().catch((err) => {
    // Evict on failure so next mount can retry (e.g. transient chunk load error).
    _langPromises.delete(lang);
    throw err;
  });

  _langPromises.set(lang, p);
  return p;
}

/**
 * Tokenise `code` for `lang` using the github-dark theme.
 * Falls back to plaintext if lang is unknown or fails to load.
 * Returns token lines suitable for React span rendering (no HTML injection).
 */
export async function highlight(code: string, lang: string | undefined): Promise<HighlightResult> {
  const hl = await getHighlighter();

  // Resolve language: attempt on-demand load; fall back to plaintext while
  // loading so callers can re-call after the promise resolves.
  let resolvedLang: BundledLanguage | SpecialLanguage = 'plaintext';
  if (lang) {
    const { isSpecialLang } = await import('shiki');
    const loaded = hl.getLoadedLanguages();
    if (isSpecialLang(lang) || loaded.includes(lang as BundledLanguage)) {
      resolvedLang = lang as BundledLanguage | SpecialLanguage;
    } else {
      // Fire load; caller should re-call after this promise settles.
      await ensureLang(lang).catch(() => { /* fallback to plaintext */ });
      // After awaiting, check again — ensureLang may have succeeded.
      if (hl.getLoadedLanguages().includes(lang as BundledLanguage)) {
        resolvedLang = lang as BundledLanguage;
      }
    }
  }

  // Use the highlighter instance directly — it already has the theme + lang
  // loaded, so codeToTokens is synchronous at this point.
  const result = hl.codeToTokens(code, {
    lang: resolvedLang,
    theme: 'github-dark',
  });

  return {
    lines: result.tokens,
    bg: result.bg ?? '#24292e',
    fg: result.fg ?? '#e1e4e8',
  };
}

/**
 * Kick off a language load without blocking. Used to pre-warm a grammar while
 * rendering plaintext immediately. Call highlight() again after the returned
 * promise settles to get coloured tokens.
 */
export function preloadLang(lang: string): Promise<void> {
  return ensureLang(lang).catch(() => { /* ignore */ });
}
