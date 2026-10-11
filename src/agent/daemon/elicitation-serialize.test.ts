/**
 * Tests for the shared `serializeRequest` helper (#3558).
 *
 * Verifies that the function correctly serializes every supported
 * ElicitationRequest field and omits undefined ones.
 *
 * @module agent/daemon/elicitation-serialize.test
 */

import { describe, it, expect } from 'vitest';
import { serializeRequest } from './elicitation-serialize.js';
import type { ElicitationRequest } from '../types/sdk-types.js';

describe('serializeRequest', () => {
  it('always includes message', () => {
    const req: ElicitationRequest = { message: 'hello', serverName: 'srv' };
    const out = serializeRequest(req);
    expect(out['message']).toBe('hello');
  });

  it('omits undefined optional fields', () => {
    const req: ElicitationRequest = { message: 'minimal', serverName: 'srv' };
    const out = serializeRequest(req);
    expect(Object.keys(out)).toEqual(['message', 'serverName']);
  });

  it('includes all present optional fields', () => {
    const req: ElicitationRequest = {
      message: 'full',
      serverName: 'srv',
      mode: 'url',
      url: 'https://example.com',
      elicitationId: 'eid-1',
      title: 'Title',
      displayName: 'Display',
      description: 'Desc',
      type: 'confirm',
      choices: ['yes', 'no'],
      questionDefault: 'yes',
      minLength: 1,
      maxLength: 100,
      min: 0,
      max: 10,
      allowSkip: true,
      allowCustom: false,
      context: 'ctx',
    };
    const out = serializeRequest(req);
    expect(out['message']).toBe('full');
    expect(out['serverName']).toBe('srv');
    expect(out['mode']).toBe('url');
    expect(out['url']).toBe('https://example.com');
    expect(out['elicitationId']).toBe('eid-1');
    expect(out['title']).toBe('Title');
    expect(out['displayName']).toBe('Display');
    expect(out['description']).toBe('Desc');
    expect(out['type']).toBe('confirm');
    expect(out['choices']).toEqual(['yes', 'no']);
    expect(out['questionDefault']).toBe('yes');
    expect(out['minLength']).toBe(1);
    expect(out['maxLength']).toBe(100);
    expect(out['min']).toBe(0);
    expect(out['max']).toBe(10);
    expect(out['allowSkip']).toBe(true);
    expect(out['allowCustom']).toBe(false);
    expect(out['context']).toBe('ctx');
  });

  it('includes requestedSchema when present', () => {
    const schema: ElicitationRequest['requestedSchema'] = { type: 'object', properties: { x: { type: 'string' } } };
    const req: ElicitationRequest = { message: 'schema test', serverName: 'srv', requestedSchema: schema };
    const out = serializeRequest(req);
    expect(out['requestedSchema']).toEqual(schema);
  });

  it('returns a plain object (no class prototype)', () => {
    const req: ElicitationRequest = { message: 'plain', serverName: 'srv' };
    const out = serializeRequest(req);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  it('output is JSON-round-trip stable', () => {
    const req: ElicitationRequest = {
      message: 'round-trip',
      serverName: 'srv',
      type: 'choice',
      choices: ['a', 'b'],
      allowCustom: true,
    };
    const out = serializeRequest(req);
    const round = JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
    expect(round).toEqual(out);
  });

  it('does not copy unknown runtime fields into durable storage', () => {
    const req = { message: 'safe', serverName: 'srv', callback: () => {}, runtime: Symbol('internal') };
    expect(serializeRequest(req)).toEqual({ message: 'safe', serverName: 'srv' });
  });
});
