// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from 'vitest';
import { $required, $optional } from './dom-utils.js';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('$required', () => {
  it('returns the element when present', () => {
    document.body.innerHTML = '<div id="target"></div>';
    const el = $required('target');
    expect(el).toBeInstanceOf(HTMLElement);
    expect(el.id).toBe('target');
  });

  it('throws with the id in the message when absent', () => {
    expect(() => $required('missing-id')).toThrow('missing #missing-id');
  });
});

describe('$optional', () => {
  it('returns the element when present', () => {
    document.body.innerHTML = '<div id="optional-target"></div>';
    const el = $optional('optional-target');
    expect(el).toBeInstanceOf(HTMLElement);
    expect(el?.id).toBe('optional-target');
  });

  it('returns null when absent', () => {
    const el = $optional('does-not-exist');
    expect(el).toBeNull();
  });
});
