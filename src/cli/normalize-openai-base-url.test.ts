/**
 * Tests for `normalizeOpenAIBaseUrl` — the `/chat/completions`-suffix
 * strip-and-warn helper invoked at config load.
 *
 * The OpenAI SDK appends `/chat/completions` to the configured `baseURL`
 * itself, so an operator passing `AFK_OPENAI_BASE_URL=…/v1/chat/completions`
 * resolves to `…/v1/chat/completions/chat/completions` at the wire — a
 * recurring user stumble. The helper:
 *
 *   1. Trims surrounding whitespace.
 *   2. Strips a trailing `/chat/completions` segment.
 *   3. Emits a one-shot stderr warning naming the corrected base URL so the
 *      operator sees the change and can update their env (and won't see
 *      the warning repeatedly on every config reload).
 *
 * These tests pin all three behaviors plus the no-op path for already-clean
 * URLs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeOpenAIBaseUrl,
  _resetOpenAIBaseUrlWarnCache,
} from './config.js';

describe('normalizeOpenAIBaseUrl', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetOpenAIBaseUrlWarnCache();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    _resetOpenAIBaseUrlWarnCache();
  });

  describe('clean URLs (no-op path)', () => {
    it.each([
      'http://127.0.0.1:8000/v1',
      'https://api.openai.com/v1',
      'https://opencode.ai/zen/go/v1',
      'http://localhost:11434/v1', // ollama
      'https://api.together.xyz/v1',
    ])('passes %s through unchanged', (input) => {
      expect(normalizeOpenAIBaseUrl(input)).toBe(input);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('trims surrounding whitespace without warning', () => {
      expect(normalizeOpenAIBaseUrl('  https://api.openai.com/v1  ')).toBe(
        'https://api.openai.com/v1',
      );
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('treats empty / whitespace input as a no-op', () => {
      expect(normalizeOpenAIBaseUrl('')).toBe('');
      expect(normalizeOpenAIBaseUrl('   ')).toBe('');
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('trailing /chat/completions strip', () => {
    it('strips the suffix from a typical bad URL', () => {
      const input = 'https://opencode.ai/zen/go/v1/chat/completions';
      expect(normalizeOpenAIBaseUrl(input)).toBe('https://opencode.ai/zen/go/v1');
    });

    it('emits a one-shot warning naming the corrected URL', () => {
      normalizeOpenAIBaseUrl('https://opencode.ai/zen/go/v1/chat/completions');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const arg = warnSpy.mock.calls[0]?.[0] as string;
      expect(arg).toContain('AFK_OPENAI_BASE_URL');
      expect(arg).toContain('stripped');
      expect(arg).toContain('https://opencode.ai/zen/go/v1');
      // The warning must NOT include the unstripped form to avoid copy-paste
      // confusion if the operator pastes the warning into a bug report.
      expect(arg).not.toContain('https://opencode.ai/zen/go/v1/chat/completions');
    });

    it('warns only once per process for the same bad value', () => {
      const bad = 'https://opencode.ai/zen/go/v1/chat/completions';
      normalizeOpenAIBaseUrl(bad);
      normalizeOpenAIBaseUrl(bad);
      normalizeOpenAIBaseUrl(bad);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('warns again for a DIFFERENT bad value', () => {
      // Operators sometimes set AFK_OPENAI_BASE_URL multiple times during a
      // session (different shims, different proxies). Each new bad value
      // deserves its own warning — silent re-strip would hide the change.
      normalizeOpenAIBaseUrl('https://provider-a.example/v1/chat/completions');
      normalizeOpenAIBaseUrl('https://provider-b.example/v1/chat/completions');
      expect(warnSpy).toHaveBeenCalledTimes(2);
    });

    it('strips after trimming whitespace', () => {
      expect(
        normalizeOpenAIBaseUrl('  https://api.together.xyz/v1/chat/completions  '),
      ).toBe('https://api.together.xyz/v1');
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('does NOT strip /chat/completions in the middle of a path', () => {
      // Hypothetical proxy with a deeper path. Only the trailing segment is
      // the SDK's responsibility — middle occurrences are user-intended.
      const input = 'https://example.com/chat/completions/v1';
      expect(normalizeOpenAIBaseUrl(input)).toBe(input);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does NOT strip /chat/completionsX (partial match)', () => {
      // Suffix match must be exact. A URL like `…/chat/completionsfoo` is
      // not the SDK's append target.
      const input = 'https://example.com/v1/chat/completionsfoo';
      expect(normalizeOpenAIBaseUrl(input)).toBe(input);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('_resetOpenAIBaseUrlWarnCache (test-only hook)', () => {
    it('clears the warn-once tracker so the next call re-warns', () => {
      const bad = 'https://opencode.ai/zen/go/v1/chat/completions';
      normalizeOpenAIBaseUrl(bad);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      _resetOpenAIBaseUrlWarnCache();
      normalizeOpenAIBaseUrl(bad);
      expect(warnSpy).toHaveBeenCalledTimes(2);
    });
  });
});
