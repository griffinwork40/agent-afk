/**
 * Unit tests for `cache-policy.ts`.
 *
 * Focused on:
 *  - env-driven enable/disable + TTL resolution
 *  - non-mutating breakpoint stampers (system + messages)
 *  - tail-cloning correctness for both string-content and array-content messages
 *  - skipped variants (thinking blocks)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ContentBlockParam,
  MessageParam,
} from '@anthropic-ai/sdk/resources';
import {
  getCacheTtl,
  isCacheEnabled,
  withMessagesBreakpoint,
  withSystemBreakpoint,
} from './cache-policy.js';

const ENV_DISABLE = 'AFK_DISABLE_PROMPT_CACHE';
const ENV_TTL = 'AFK_PROMPT_CACHE_TTL';

function clearEnv(): void {
  delete process.env[ENV_DISABLE];
  delete process.env[ENV_TTL];
}

describe('cache-policy', () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  describe('isCacheEnabled', () => {
    it('returns true by default', () => {
      expect(isCacheEnabled()).toBe(true);
    });

    it('returns false when AFK_DISABLE_PROMPT_CACHE is "1"', () => {
      process.env[ENV_DISABLE] = '1';
      expect(isCacheEnabled()).toBe(false);
    });

    it('returns false for "true", "yes", "on" (any case)', () => {
      for (const v of ['true', 'TRUE', 'yes', 'YES', 'on', 'On']) {
        process.env[ENV_DISABLE] = v;
        expect(isCacheEnabled()).toBe(false);
      }
    });

    it('returns true for empty or unrecognized values', () => {
      for (const v of ['', '0', 'false', 'no', 'maybe']) {
        process.env[ENV_DISABLE] = v;
        expect(isCacheEnabled()).toBe(true);
      }
    });

    it('force-disables when baseUrl is set, regardless of env', () => {
      // Local Anthropic-compatible shims rarely honor `cache_control` and
      // some 400 on the unknown field. Guard at the policy level.
      expect(isCacheEnabled({ baseUrl: 'http://127.0.0.1:8080' })).toBe(false);
      process.env[ENV_DISABLE] = 'false'; // even if env tries to force on
      expect(isCacheEnabled({ baseUrl: 'http://127.0.0.1:8080' })).toBe(false);
    });

    it('empty baseUrl is treated as unset (env logic still applies)', () => {
      expect(isCacheEnabled({ baseUrl: '' })).toBe(true);
      expect(isCacheEnabled({ baseUrl: undefined })).toBe(true);
      process.env[ENV_DISABLE] = '1';
      expect(isCacheEnabled({ baseUrl: '' })).toBe(false);
    });
  });

  describe('getCacheTtl', () => {
    it('defaults to 1h', () => {
      expect(getCacheTtl()).toBe('1h');
    });

    it('honors AFK_PROMPT_CACHE_TTL=5m', () => {
      process.env[ENV_TTL] = '5m';
      expect(getCacheTtl()).toBe('5m');
    });

    it('falls back to default for any other value', () => {
      for (const v of ['10m', '2h', 'forever', '']) {
        process.env[ENV_TTL] = v;
        expect(getCacheTtl()).toBe('1h');
      }
    });
  });

  describe('withSystemBreakpoint', () => {
    it('returns the same array when empty', () => {
      const blocks: ContentBlockParam[] = [];
      expect(withSystemBreakpoint(blocks, '1h')).toBe(blocks);
    });

    it('stamps cache_control on the last block, leaves earlier blocks untouched', () => {
      const blocks: ContentBlockParam[] = [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ];
      const out = withSystemBreakpoint(blocks, '1h');
      expect(out).not.toBe(blocks);
      expect(out[0]).toBe(blocks[0]); // unchanged reference
      expect(out[1]).toEqual({
        type: 'text',
        text: 'second',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      });
      // Original input must remain unmutated.
      expect(blocks[1]).toEqual({ type: 'text', text: 'second' });
    });

    it('honors the provided TTL', () => {
      const blocks: ContentBlockParam[] = [{ type: 'text', text: 'x' }];
      const out = withSystemBreakpoint(blocks, '5m');
      expect((out[0] as { cache_control?: { ttl?: string } }).cache_control?.ttl).toBe('5m');
    });

    it('skips when the tail is a thinking block (SDK rejects cache_control there)', () => {
      const blocks: ContentBlockParam[] = [
        { type: 'text', text: 'x' },
        { type: 'thinking', thinking: 'reasoning', signature: 'sig' },
      ];
      const out = withSystemBreakpoint(blocks, '1h');
      expect(out).toBe(blocks);
    });
  });

  describe('withMessagesBreakpoint', () => {
    it('returns the same array when empty', () => {
      const msgs: MessageParam[] = [];
      expect(withMessagesBreakpoint(msgs, '1h')).toBe(msgs);
    });

    it('clones the tail message; converts string content to a text block with cache_control', () => {
      const msgs: MessageParam[] = [
        { role: 'user', content: 'hello' },
      ];
      const out = withMessagesBreakpoint(msgs, '1h');
      expect(out).not.toBe(msgs);
      expect(out[0]).not.toBe(msgs[0]);
      expect(out[0]?.content).toEqual([
        {
          type: 'text',
          text: 'hello',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ]);
      // Original message must remain unmutated.
      expect(msgs[0]?.content).toBe('hello');
    });

    it('clones the tail and stamps cache_control on the last content block', () => {
      const tailContent: ContentBlockParam[] = [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ];
      const msgs: MessageParam[] = [
        { role: 'user', content: 'first user turn' },
        { role: 'user', content: tailContent },
      ];
      const out = withMessagesBreakpoint(msgs, '1h');
      expect(out[0]).toBe(msgs[0]); // earlier message untouched
      const stampedContent = out[1]?.content as ContentBlockParam[];
      expect(stampedContent[0]).toBe(tailContent[0]);
      expect(stampedContent[1]).toEqual({
        type: 'text',
        text: 'b',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      });
      // Source array must remain unmutated.
      expect(tailContent[1]).toEqual({ type: 'text', text: 'b' });
    });

    it('stamps tool_result tail (the common case in tool-use loop iterations)', () => {
      const msgs: MessageParam[] = [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'echo', input: {} }],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
          ],
        },
      ];
      const out = withMessagesBreakpoint(msgs, '5m');
      const tailContent = out[2]?.content as ContentBlockParam[];
      expect(tailContent[0]).toEqual({
        type: 'tool_result',
        tool_use_id: 't1',
        content: 'ok',
        cache_control: { type: 'ephemeral', ttl: '5m' },
      });
    });

    it('non-mutating: subsequent calls produce identical output (no marker accumulation)', () => {
      const msgs: MessageParam[] = [
        { role: 'user', content: 'hello' },
      ];
      const out1 = withMessagesBreakpoint(msgs, '1h');
      const out2 = withMessagesBreakpoint(msgs, '1h');
      expect(out1[0]?.content).toEqual(out2[0]?.content);
      // Stored history shows zero cache_control markers.
      const stored = msgs[0]?.content;
      expect(typeof stored).toBe('string');
    });
  });
});
