import { describe, expect, it } from 'vitest';

import { EXCLUDED_DIRS, isScannable } from '../scripts/lib/file-size-scope.js';

describe('check-file-size scan scope — isScannable', () => {
  it('includes authored source files', () => {
    expect(isScannable('src/agent/session.ts')).toBe(true);
    expect(isScannable('src/cli/view.tsx')).toBe(true);
    expect(isScannable('scripts/lib/copy-bundled-plugins.mjs')).toBe(true);
    expect(isScannable('scripts/check-file-size.ts')).toBe(true);
  });

  it('excludes the gitignored web-ui-assets Vite bundle (#2206)', () => {
    expect(EXCLUDED_DIRS).toContain('web-ui-assets');
    expect(isScannable('src/web-ui-assets/assets/index.js')).toBe(false);
    expect(isScannable('src\\web-ui-assets\\assets\\index.js')).toBe(false);
  });

  it('excludes tests, specs, and declaration files', () => {
    expect(isScannable('src/agent/session.test.ts')).toBe(false);
    expect(isScannable('src/agent/session.spec.ts')).toBe(false);
    expect(isScannable('src/types/global.d.ts')).toBe(false);
  });

  it('excludes fixture, test-util, dependency, and build directories', () => {
    expect(isScannable('src/cli/__fixtures__/big.ts')).toBe(false);
    expect(isScannable('src/agent/__test-utils__/helpers.ts')).toBe(false);
    expect(isScannable('node_modules/pkg/index.js')).toBe(false);
    expect(isScannable('dist/cli.mjs')).toBe(false);
  });

  it('excludes non-source extensions', () => {
    expect(isScannable('src/README.md')).toBe(false);
    expect(isScannable('src/data.json')).toBe(false);
  });

  it('matches excluded directories by whole path segment, not substring', () => {
    expect(isScannable('src/distribution/index.ts')).toBe(true);
    expect(isScannable('src/web-ui-assets-helper/index.ts')).toBe(true);
  });
});
