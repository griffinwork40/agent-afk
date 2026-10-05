import { describe, expect, it } from 'vitest';
import { buildParentCredentialOpt } from './compose-executor.credential.js';

describe('buildParentCredentialOpt (#2844)', () => {
  it('pairs the key with its source model when both are known', () => {
    expect(buildParentCredentialOpt('sk-ant-x', 'claude-sonnet-4-6')).toEqual({
      parentCredential: { key: 'sk-ant-x', sourceModel: 'claude-sonnet-4-6' },
    });
  });

  it('returns {} when the api key is absent', () => {
    expect(buildParentCredentialOpt(undefined, 'claude-sonnet-4-6')).toEqual({});
  });

  it('returns {} (never the string "undefined") when the source model is absent', () => {
    expect(buildParentCredentialOpt('sk-ant-x', undefined)).toEqual({});
  });
});
