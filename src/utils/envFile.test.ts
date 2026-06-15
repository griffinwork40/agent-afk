import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  upsertEnvVar,
  removeEnvVar,
  readEnvVarFromFile,
  readEnvFile,
} from './envFile.js';

describe('envFile primitives', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'afk-envfile-'));
    file = join(dir, 'afk.env');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('upsertEnvVar', () => {
    it('creates the file (and parent dirs) on first write with 0600 perms', () => {
      const nested = join(dir, 'sub', 'config', 'afk.env');
      upsertEnvVar(nested, 'AFK_MODEL', 'sonnet');
      expect(existsSync(nested)).toBe(true);
      expect(readEnvVarFromFile(nested, 'AFK_MODEL')).toBe('sonnet');
      // 0o600 — owner read/write only.
      expect(statSync(nested).mode & 0o777).toBe(0o600);
    });

    it('replaces an existing key in place, preserving comments / blanks / order', () => {
      writeFileSync(
        file,
        '# header comment\nAFK_MODEL=sonnet\n\nAFK_SHOW_DIFFS=true\n# trailing\n',
      );
      upsertEnvVar(file, 'AFK_MODEL', 'opus');
      expect(readFileSync(file, 'utf-8')).toBe(
        '# header comment\nAFK_MODEL=opus\n\nAFK_SHOW_DIFFS=true\n# trailing\n',
      );
    });

    it('appends a new key with a trailing newline when absent', () => {
      writeFileSync(file, 'AFK_MODEL=sonnet\n');
      upsertEnvVar(file, 'AFK_SHOW_DIFFS', 'true');
      expect(readFileSync(file, 'utf-8')).toBe('AFK_MODEL=sonnet\nAFK_SHOW_DIFFS=true\n');
    });

    it('strips keysToRemove in the same pass', () => {
      writeFileSync(file, 'ANTHROPIC_API_KEY=old\nAFK_MODEL=sonnet\n');
      upsertEnvVar(file, 'CLAUDE_CODE_OAUTH_TOKEN', 'tok', ['ANTHROPIC_API_KEY']);
      const parsed = readEnvFile(file);
      expect(parsed['ANTHROPIC_API_KEY']).toBeUndefined();
      expect(parsed['CLAUDE_CODE_OAUTH_TOKEN']).toBe('tok');
      expect(parsed['AFK_MODEL']).toBe('sonnet');
    });

    it('does not corrupt the file when the key contains regex metacharacters', () => {
      // Engine may pass arbitrary keys; an unescaped `.` or `$` would over-match.
      writeFileSync(file, 'A.B=1\nAXB=2\n');
      upsertEnvVar(file, 'A.B', '9');
      const parsed = readEnvFile(file);
      expect(parsed['A.B']).toBe('9');
      expect(parsed['AXB']).toBe('2'); // unescaped `A.B` regex would have clobbered AXB
    });
  });

  describe('removeEnvVar', () => {
    it('removes a key and reports true; preserves the rest', () => {
      writeFileSync(file, '# c\nAFK_MODEL=sonnet\nAFK_SHOW_DIFFS=true\n');
      expect(removeEnvVar(file, 'AFK_MODEL')).toBe(true);
      expect(readFileSync(file, 'utf-8')).toBe('# c\nAFK_SHOW_DIFFS=true\n');
    });

    it('returns false when the key is absent', () => {
      writeFileSync(file, 'AFK_MODEL=sonnet\n');
      expect(removeEnvVar(file, 'NOPE')).toBe(false);
    });

    it('returns false (no throw) when the file does not exist', () => {
      expect(removeEnvVar(join(dir, 'missing.env'), 'AFK_MODEL')).toBe(false);
    });
  });

  describe('readEnvVarFromFile / readEnvFile', () => {
    it('reads a single value and undefined for missing', () => {
      writeFileSync(file, 'AFK_MODEL=sonnet\n');
      expect(readEnvVarFromFile(file, 'AFK_MODEL')).toBe('sonnet');
      expect(readEnvVarFromFile(file, 'MISSING')).toBeUndefined();
    });

    it('parses all key=value pairs, skipping comments and blanks', () => {
      writeFileSync(file, '# comment\n\nAFK_MODEL=sonnet\nAFK_EFFORT=high\n');
      expect(readEnvFile(file)).toEqual({ AFK_MODEL: 'sonnet', AFK_EFFORT: 'high' });
    });

    it('returns {} for a missing file', () => {
      expect(readEnvFile(join(dir, 'missing.env'))).toEqual({});
    });
  });
});
