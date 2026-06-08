/**
 * Unit tests for `plan-mode-addendum.ts`.
 *
 * Verifies the pure builder behaves correctly across permission modes and
 * that the addendum text names the topology and the skills the model needs
 * to reach for (regression guard against accidental message drift).
 */

import { describe, it, expect } from 'vitest';
import {
  PLAN_MODE_ADDENDUM_TEXT,
  buildPlanModeAddendumBlock,
} from './plan-mode-addendum.js';

describe('plan-mode-addendum', () => {
  describe('buildPlanModeAddendumBlock', () => {
    it('returns null for default mode', () => {
      expect(buildPlanModeAddendumBlock('default')).toBeNull();
    });

    it('returns null for undefined mode', () => {
      expect(buildPlanModeAddendumBlock(undefined)).toBeNull();
    });

    it('returns null for unrecognized modes', () => {
      expect(buildPlanModeAddendumBlock('bypassPermissions')).toBeNull();
      expect(buildPlanModeAddendumBlock('acceptEdits')).toBeNull();
      expect(buildPlanModeAddendumBlock('')).toBeNull();
    });

    it('returns a text block when mode is exactly "plan"', () => {
      const block = buildPlanModeAddendumBlock('plan');
      expect(block).not.toBeNull();
      expect(block).toMatchObject({
        type: 'text',
        text: PLAN_MODE_ADDENDUM_TEXT,
      });
    });

    it('does not stamp cache_control on its own block', () => {
      const block = buildPlanModeAddendumBlock('plan');
      expect(block).not.toBeNull();
      expect(block as { cache_control?: unknown }).not.toHaveProperty('cache_control');
    });

    it('is case-sensitive — "Plan" or "PLAN" do not activate', () => {
      expect(buildPlanModeAddendumBlock('Plan')).toBeNull();
      expect(buildPlanModeAddendumBlock('PLAN')).toBeNull();
    });
  });

  describe('PLAN_MODE_ADDENDUM_TEXT', () => {
    it('declares plan mode is active', () => {
      expect(PLAN_MODE_ADDENDUM_TEXT.toLowerCase()).toContain('plan mode');
    });

    it('names the write-class tools that are refused', () => {
      // Regression guard: if the gate's denylist changes, this should change
      // in lockstep so the model is told the truth about what is refused.
      expect(PLAN_MODE_ADDENDUM_TEXT).toContain('write_file');
      expect(PLAN_MODE_ADDENDUM_TEXT).toContain('edit_file');
      expect(PLAN_MODE_ADDENDUM_TEXT.toLowerCase()).toContain('bash');
    });

    it('names the topology stages', () => {
      // The shape the model is asked to traverse. If this drifts, plan mode
      // is no longer a topology directive — it is just refusal copy.
      const text = PLAN_MODE_ADDENDUM_TEXT.toLowerCase();
      expect(text).toContain('ground');
      expect(text).toContain('gather');
      expect(text).toContain('risks');
      expect(text).toMatch(/adversarial|pressure/);
    });

    it('names the planning-topology skills', () => {
      // These must match bundled-plugin skill names so the model can
      // actually invoke them via the `skill` tool.
      expect(PLAN_MODE_ADDENDUM_TEXT).toContain('ground-state');
      expect(PLAN_MODE_ADDENDUM_TEXT).toContain('gather');
      expect(PLAN_MODE_ADDENDUM_TEXT).toContain('research');
      expect(PLAN_MODE_ADDENDUM_TEXT).toContain('devils-advocate');
      expect(PLAN_MODE_ADDENDUM_TEXT).toContain('shadow-verify');
    });

    it('names the plan-readiness requirements', () => {
      // When the plan is ready the model states these three sections; on
      // `/plan off` that plan is saved to a file and implemented. The addendum
      // primes the model to keep the plan concrete enough to act on directly.
      const text = PLAN_MODE_ADDENDUM_TEXT.toLowerCase();
      expect(text).toContain('chosen approach');
      expect(text).toContain('risks');
      expect(text).toContain('alternatives');
    });

    it('names /plan off as the exit affordance', () => {
      expect(PLAN_MODE_ADDENDUM_TEXT).toContain('/plan off');
    });
  });
});
