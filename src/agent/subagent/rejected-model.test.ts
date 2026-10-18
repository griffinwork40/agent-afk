/**
 * Tests for rejected-model classifier.
 *
 * Run with: pnpm test src/agent/subagent/rejected-model.test.ts
 */

import { describe, it, expect } from 'vitest';
import { classifyRejectedModel } from './rejected-model.js';

describe('classifyRejectedModel', () => {
  describe('model-rejection errors → isModelRejection: true', () => {
    it('classifies ChatGPT backend 400 rejection', () => {
      const msg =
        'ChatGPT/Codex backend rejected model "q36-hf" (HTTP 400). This is a ChatGPT-subscription backend restriction';
      const result = classifyRejectedModel(msg);
      expect(result.isModelRejection).toBe(true);
      expect(result.reason.length).toBeLessThanOrEqual(120);
    });

    it('classifies chatGptClaudeModelError', () => {
      const msg =
        `Model "claude-opus-5-5" can't run on a ChatGPT subscription — the ChatGPT/Codex backend only supports OpenAI gpt-5.x models.`;
      expect(classifyRejectedModel(msg).isModelRejection).toBe(true);
    });

    it('classifies OpenAI model not found (404)', () => {
      const msg = 'The model `q36-hf` does not exist — 404 model not found.';
      expect(classifyRejectedModel(msg).isModelRejection).toBe(true);
    });

    it('classifies "invalid model" (400)', () => {
      const msg = 'HTTP 400 invalid model: the model id supplied is not valid for this endpoint.';
      expect(classifyRejectedModel(msg).isModelRejection).toBe(true);
    });

    it('classifies "model does not exist"', () => {
      const msg = 'The model does not exist in our catalog.';
      expect(classifyRejectedModel(msg).isModelRejection).toBe(true);
    });

    it('classifies bare 400 with model-rejection pattern', () => {
      // status=400 + no non-model override pattern → eligible
      const msg = '400 status code: unsupported model "my-model-x"';
      expect(classifyRejectedModel(msg).isModelRejection).toBe(true);
    });

    it('classifies bare 404 as model rejection', () => {
      const msg = '404 status code (no body) from provider';
      expect(classifyRejectedModel(msg).isModelRejection).toBe(true);
    });
  });

  describe('transient / non-model errors → isModelRejection: false', () => {
    it('does NOT classify 429 rate-limit as model rejection', () => {
      const msg = 'Rate limit exceeded (429). Please retry after 30s.';
      expect(classifyRejectedModel(msg).isModelRejection).toBe(false);
    });

    it('does NOT classify 500 internal server error as model rejection', () => {
      const msg = 'Internal server error (500). Try again later.';
      expect(classifyRejectedModel(msg).isModelRejection).toBe(false);
    });

    it('does NOT classify 503 as model rejection', () => {
      const msg = 'Service unavailable 503.';
      expect(classifyRejectedModel(msg).isModelRejection).toBe(false);
    });

    it('does NOT classify org-level OAuth 403 as model rejection', () => {
      const msg =
        'Request failed: 403 oauth_not_allowed_for_organization — your organization has disabled this endpoint.';
      expect(classifyRejectedModel(msg).isModelRejection).toBe(false);
    });

    it('does NOT classify usage-limit error as model rejection', () => {
      const msg = 'Usage limit reached. Your subscription usage_limit has been exceeded.';
      expect(classifyRejectedModel(msg).isModelRejection).toBe(false);
    });

    it('does NOT classify credit balance error as model rejection', () => {
      const msg = 'Insufficient credit balance. Please add credits to continue.';
      expect(classifyRejectedModel(msg).isModelRejection).toBe(false);
    });

    it('does NOT classify permission denied as model rejection', () => {
      const msg = 'Permission denied to access this resource.';
      expect(classifyRejectedModel(msg).isModelRejection).toBe(false);
    });

    it('does NOT classify a generic unknown error', () => {
      const msg = 'Something went wrong with the network.';
      expect(classifyRejectedModel(msg).isModelRejection).toBe(false);
    });
  });

  describe('reason truncation', () => {
    it('truncates reason to ≤120 chars', () => {
      const longMsg = 'a'.repeat(300);
      const result = classifyRejectedModel(longMsg);
      expect(result.reason.length).toBeLessThanOrEqual(120);
    });
  });
});
