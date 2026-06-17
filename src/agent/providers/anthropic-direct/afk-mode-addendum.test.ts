/**
 * Unit tests for `afk-mode-addendum.ts`.
 *
 * Verifies the pure builder activates only for `'autonomous'` mode and that
 * the addendum text encodes the bounded-autonomy posture (regression guard
 * against accidental message drift toward unchecked "YOLO" autonomy).
 */

import { describe, it, expect } from 'vitest';
import {
  AFK_MODE_ADDENDUM_TEXT,
  buildAfkModeAddendumBlock,
} from './afk-mode-addendum.js';

describe('afk-mode-addendum', () => {
  describe('buildAfkModeAddendumBlock', () => {
    it('returns null for default mode', () => {
      expect(buildAfkModeAddendumBlock('default')).toBeNull();
    });

    it('returns null for undefined mode', () => {
      expect(buildAfkModeAddendumBlock(undefined)).toBeNull();
    });

    it('returns null for plan mode (mutually exclusive — plan has its own addendum)', () => {
      expect(buildAfkModeAddendumBlock('plan')).toBeNull();
    });

    it('returns null for other permission modes', () => {
      expect(buildAfkModeAddendumBlock('bypassPermissions')).toBeNull();
      expect(buildAfkModeAddendumBlock('acceptEdits')).toBeNull();
      expect(buildAfkModeAddendumBlock('')).toBeNull();
    });

    it('returns a text block when mode is exactly "autonomous"', () => {
      const block = buildAfkModeAddendumBlock('autonomous');
      expect(block).not.toBeNull();
      expect(block).toMatchObject({ type: 'text', text: AFK_MODE_ADDENDUM_TEXT });
    });

    it('does not stamp cache_control on its own block', () => {
      const block = buildAfkModeAddendumBlock('autonomous');
      expect(block).not.toBeNull();
      expect(block as { cache_control?: unknown }).not.toHaveProperty('cache_control');
    });

    it('is case-sensitive — "Autonomous" does not activate', () => {
      expect(buildAfkModeAddendumBlock('Autonomous')).toBeNull();
      expect(buildAfkModeAddendumBlock('AUTONOMOUS')).toBeNull();
    });
  });

  describe('AFK_MODE_ADDENDUM_TEXT', () => {
    it('declares AFK mode is active', () => {
      expect(AFK_MODE_ADDENDUM_TEXT.toLowerCase()).toContain('afk mode');
    });

    it('names Telegram + send_telegram as the operator channel', () => {
      expect(AFK_MODE_ADDENDUM_TEXT).toContain('Telegram');
      expect(AFK_MODE_ADDENDUM_TEXT).toContain('send_telegram');
    });

    it('encodes bounded autonomy — proceed on reversible, stop at one-way doors', () => {
      // Regression guard: the posture must remain BOUNDED. If these markers
      // drift the addendum risks becoming an unchecked-autonomy ("YOLO")
      // directive, which is the exact failure mode the mechanical gate + this
      // text are designed to prevent.
      const text = AFK_MODE_ADDENDUM_TEXT.toLowerCase();
      expect(text).toContain('reversible');
      expect(text).toMatch(/irreversible|one-way door/);
      expect(text).toContain('asking');
    });

    it('defers to the mechanical gate (posture is not the safety mechanism)', () => {
      expect(AFK_MODE_ADDENDUM_TEXT.toLowerCase()).toContain('gate');
    });

    it('directs the model to report terminal state at end of turn', () => {
      expect(AFK_MODE_ADDENDUM_TEXT.toLowerCase()).toContain('terminal state');
    });

    it('names /afk off as the exit affordance', () => {
      expect(AFK_MODE_ADDENDUM_TEXT).toContain('/afk off');
    });
  });
});
