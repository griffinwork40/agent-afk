import { describe, expect, it } from 'vitest';
import { parseSidecarDisplayName, parseSidecarName, parseSidecarNameExplicit } from './session-name-head.js';

describe('parseSidecarName', () => {
  it('reads the top-level name from a pretty-printed sidecar head', () => {
    const head = JSON.stringify({ sessionId: 'a', name: 'tackle-issues-5', model: 'm', turns: [] }, null, 2);
    expect(parseSidecarName(head)).toBe('tackle-issues-5');
  });

  it('decodes JSON escapes in the name', () => {
    const head = JSON.stringify({ sessionId: 'a', name: 'say "hi"', turns: [] }, null, 2);
    expect(parseSidecarName(head)).toBe('say "hi"');
  });

  it('ignores a nested name inside turns when there is no top-level name', () => {
    const head = JSON.stringify({ sessionId: 'a', turns: [{ name: 'bash' }] }, null, 2);
    expect(parseSidecarName(head)).toBeUndefined();
  });

  it('returns undefined for a name cut off by the head boundary', () => {
    expect(parseSidecarName('{\n  "sessionId": "a",\n  "name": "trunc')).toBeUndefined();
  });

  it('returns undefined for an empty name', () => {
    expect(parseSidecarName('{\n  "name": "  ",\n  "turns": []\n}')).toBeUndefined();
  });
});

describe('parseSidecarNameExplicit', () => {
  it('is true only for a top-level nameExplicit:true before turns', () => {
    expect(parseSidecarNameExplicit('{\n  "sessionId": "a",\n  "name": "my-name",\n  "nameExplicit": true,\n  "turns": []\n}')).toBe(true);
    expect(parseSidecarNameExplicit('{\n  "sessionId": "a",\n  "name": "auto-slug",\n  "turns": []\n}')).toBe(false);
    expect(parseSidecarNameExplicit('{\n  "name": "x",\n  "turns": [\n    {\n  "nameExplicit": true\n    }\n  ]\n}')).toBe(false);
  });
});

describe('parseSidecarDisplayName', () => {
  it('reads the verbatim top-level displayName before turns only', () => {
    expect(parseSidecarDisplayName('{\n  "sessionId": "a",\n  "name": "job-queue",\n  "nameExplicit": true,\n  "displayName": "Job queue \\"Q\\"",\n  "turns": []\n}')).toBe('Job queue "Q"');
    expect(parseSidecarDisplayName('{\n  "name": "x",\n  "turns": [\n    {\n  "displayName": "nested"\n    }\n  ]\n}')).toBeUndefined();
  });
});

