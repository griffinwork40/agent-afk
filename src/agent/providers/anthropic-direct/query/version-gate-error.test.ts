/**
 * #2075: the API's `claude_code_version_too_old` rejection must reach the
 * operator with a fix-it line naming CLI_USER_AGENT, while every other error
 * passes through untouched and SDK error properties survive the rewrap.
 */
import { describe, it, expect, vi } from 'vitest';
import type { MessageParam } from '@anthropic-ai/sdk/resources';
import { CLI_USER_AGENT } from '../auth.js';
import { runTurn } from '../loop.js';
import { collect, ctx, makeDispatcher } from '../loop.test-helpers.js';
import type { AnthropicClientLike } from '../types.js';
import { annotateFastError, FAST_ERROR_PREFIX } from './turn-request.js';
import {
  annotateVersionGateError,
  isVersionGateError,
  VERSION_GATE_ERROR_CODE,
  VERSION_GATE_ERROR_PREFIX,
} from './version-gate-error.js';

const rawMessage =
  `400 {"type":"error","error":{"type":"invalid_request_error","code":"${VERSION_GATE_ERROR_CODE}",` +
  '"message":"Claude Code version is too old for this model"}}';

function gateError(): Error {
  return Object.assign(new Error(rawMessage), {
    status: 400,
    headers: { 'request-id': 'req_123' },
    error: { type: 'error', error: { type: 'invalid_request_error', code: VERSION_GATE_ERROR_CODE } },
  });
}

describe('isVersionGateError', () => {
  it('matches the code in the message', () => {
    expect(isVersionGateError(new Error(`blocked: ${VERSION_GATE_ERROR_CODE}`))).toBe(true);
  });

  it('matches the code only present in the parsed `.error` body', () => {
    const err = Object.assign(new Error('400 Bad Request'), {
      status: 400,
      error: { error: { code: VERSION_GATE_ERROR_CODE } },
    });
    expect(isVersionGateError(err)).toBe(true);
  });

  it('does not match unrelated 400s', () => {
    const err = Object.assign(new Error('400 invalid_request_error: credit balance is too low'), {
      status: 400,
      error: { error: { type: 'invalid_request_error' } },
    });
    expect(isVersionGateError(err)).toBe(false);
  });

  it('tolerates an unserializable `.error` body', () => {
    const body: Record<string, unknown> = {};
    body['self'] = body;
    expect(isVersionGateError(Object.assign(new Error('x'), { error: body }))).toBe(false);
  });
});

describe('annotateVersionGateError', () => {
  it('prepends a hint naming CLI_USER_AGENT and keeps the original message', () => {
    const e = annotateVersionGateError(gateError());
    expect(e.message.startsWith(VERSION_GATE_ERROR_PREFIX)).toBe(true);
    expect(e.message).toContain('CLI_USER_AGENT');
    expect(e.message).toContain(CLI_USER_AGENT);
    expect(e.message).toContain('npm view @anthropic-ai/claude-code version');
    expect(e.message).toContain(rawMessage);
  });

  it('preserves own SDK properties and links cause', () => {
    const original = gateError();
    const e = annotateVersionGateError(original) as Error & {
      status?: number;
      headers?: unknown;
      error?: unknown;
    };
    expect(e.status).toBe(400);
    expect(e.headers).toEqual({ 'request-id': 'req_123' });
    expect(e.error).toBe((original as Error & { error: unknown }).error);
    expect(e.cause).toBe(original);
  });

  it('returns unrelated errors unchanged (same reference)', () => {
    const err = Object.assign(new Error('Bad request'), { status: 400 });
    expect(annotateVersionGateError(err)).toBe(err);
  });

  it('is idempotent', () => {
    const once = annotateVersionGateError(gateError());
    expect(annotateVersionGateError(once)).toBe(once);
  });

  it('composes with the Fast-mode annotation without losing either prefix', () => {
    const e = annotateVersionGateError(annotateFastError(gateError(), true));
    expect(e.message.startsWith(VERSION_GATE_ERROR_PREFIX)).toBe(true);
    expect(e.message).toContain(FAST_ERROR_PREFIX);
    expect((e as Error & { status?: number }).status).toBe(400);
  });
});

describe('runTurn surfaces the version-gate hint (wiring)', () => {
  it('annotates a connection-phase version-gate rejection on the error event', async () => {
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => {
          throw gateError();
        }),
      },
    };
    const messages: MessageParam[] = [{ role: 'user', content: 'hi' }];
    const events = await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: null,
        toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
        model: 'claude-opus-5-5',
        maxTokens: 1024,
        headers: {},
        signal: new AbortController().signal,
        ctx,
      }),
    );
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type !== 'error') throw new Error('expected error event');
    expect(errorEvent.error.message.startsWith(VERSION_GATE_ERROR_PREFIX)).toBe(true);
    expect(errorEvent.error.message).toContain('CLI_USER_AGENT');
  });
});
