/**
 * Tests for parsePortFile — port discovery file parsing.
 */

import { describe, it, expect } from 'vitest';
import { parsePortFile } from './http-client.js';

describe('parsePortFile', () => {
  it('"7777" → { host: "localhost", port: 7777 }', () => {
    expect(parsePortFile('7777')).toEqual({ host: 'localhost', port: 7777 });
  });

  it('"127.0.0.1:7777" → { host: "127.0.0.1", port: 7777 }', () => {
    expect(parsePortFile('127.0.0.1:7777')).toEqual({ host: '127.0.0.1', port: 7777 });
  });

  it('"::1:7777" → { host: "::1", port: 7777 }', () => {
    expect(parsePortFile('::1:7777')).toEqual({ host: '::1', port: 7777 });
  });

  it('"::1" → null (bare IPv6 address with no port suffix)', () => {
    // Without a port suffix, the last-colon split yields host="::" and port=1.
    // "::" is a colon-only host, so we reject it.
    expect(parsePortFile('::1')).toBeNull();
  });

  it('"garbage" → null', () => {
    expect(parsePortFile('garbage')).toBeNull();
  });

  it('"" → null', () => {
    expect(parsePortFile('')).toBeNull();
  });
});
