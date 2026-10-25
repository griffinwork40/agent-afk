import { describe, it, expect } from 'vitest';
import { classifyModelRejection, isModelRejectedError, ModelRejectedError } from './model-rejected-error.js';
import { clarifyResponsesError, chatGptClaudeModelError } from '../openai-compatible/query/chatgpt-backend-errors.js';

/** Shape of an SDK APIError: numeric `status` + parsed body on `error`. */
function sdkError(status: number, body: unknown, message = `${status} error`): Error {
  return Object.assign(new Error(message), { status, error: body });
}

describe('classifyModelRejection — eligible (structured)', () => {
  it('ChatGPT backend body-less 400 is typed at the source', () => {
    const err = clarifyResponsesError(sdkError(400, undefined, '400 status code (no body)'), true, 'q36-hf');
    expect(err).toBeInstanceOf(ModelRejectedError);
    expect(err).toMatchObject({ model: 'q36-hf', status: 400, provider: 'openai-compatible', code: 'model_rejected' });
    expect(classifyModelRejection(err, 'q36-hf', 'openai-compatible')).toBe(err);
  });

  it('ChatGPT backend Claude-model guard is typed', () => {
    expect(isModelRejectedError(chatGptClaudeModelError('sonnet'))).toBe(true);
  });

  it('OpenAI model_not_found (top-level code) is eligible', () => {
    const err = Object.assign(sdkError(404, { code: 'model_not_found', message: 'The model `x` does not exist' }), { code: 'model_not_found' });
    expect(classifyModelRejection(err, 'x', 'openai-compatible')?.status).toBe(404);
  });

  it('Anthropic 404 not_found_error naming the model is eligible', () => {
    const err = sdkError(404, { type: 'error', error: { type: 'not_found_error', message: 'model: claude-nope' } });
    expect(classifyModelRejection(err, 'claude-nope', 'anthropic-direct')).toBeInstanceOf(ModelRejectedError);
  });

  it('Anthropic 400 invalid model is eligible', () => {
    const err = sdkError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'model: invalid model name' } });
    expect(classifyModelRejection(err, 'bad', 'anthropic-direct')).toBeInstanceOf(ModelRejectedError);
  });
});

describe('classifyModelRejection — NOT eligible', () => {
  it('prompt-too-long 400', () => {
    const err = sdkError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens > 200000 maximum' } });
    expect(classifyModelRejection(err, 'sonnet', 'anthropic-direct')).toBeUndefined();
  });

  it('bad tool schema 400', () => {
    const err = sdkError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'tools.3.input_schema: invalid JSON schema' } });
    expect(classifyModelRejection(err, 'sonnet', 'anthropic-direct')).toBeUndefined();
  });

  it('ChatGPT backend 400 whose body is about the context window is not typed', () => {
    const err = clarifyResponsesError(sdkError(400, { detail: 'Your input exceeds the context window' }), true, 'gpt-5.5');
    expect(isModelRejectedError(err)).toBe(false);
    expect(classifyModelRejection(err, 'gpt-5.5', 'openai-compatible')).toBeUndefined();
  });

  it('403 oauth_not_allowed_for_organization', () => {
    const err = sdkError(403, { type: 'error', error: { type: 'permission_error', message: 'oauth_not_allowed_for_organization model' } });
    expect(classifyModelRejection(err, 'sonnet', 'anthropic-direct')).toBeUndefined();
  });

  it('429 even with model_not_found-ish body', () => {
    const err = Object.assign(sdkError(429, { code: 'model_not_found' }), { code: 'model_not_found' });
    expect(classifyModelRejection(err, 'x', 'openai-compatible')).toBeUndefined();
  });

  it.each([500, 502, 503, 529])('%i', (status) => {
    expect(classifyModelRejection(sdkError(status, { type: 'error', error: { type: 'not_found_error', message: 'model: x' } }), 'x', 'anthropic-direct')).toBeUndefined();
  });

  it('plain Error whose MESSAGE mentions a 404 model (prose is never parsed)', () => {
    expect(classifyModelRejection(new Error('HTTP 404 model not found: x'), 'x', 'anthropic-direct')).toBeUndefined();
  });

  it('non-ChatGPT backend 400 passes through clarifyResponsesError untyped', () => {
    expect(isModelRejectedError(clarifyResponsesError(sdkError(400, undefined), false, 'gpt-5.5'))).toBe(false);
  });
});
