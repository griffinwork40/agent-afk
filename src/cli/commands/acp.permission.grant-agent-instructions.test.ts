/**
 * Red team 3b, item 1: a remembered write_file grant covers AFK.md and
 * .afk/skills/<name>/SKILL.md, both re-read on every prompt turn / skill
 * invocation. Neither is on the sensitive list in acp.permission.sensitive.ts.
 * A model that earns "Always allow write_file" for any ordinary file can then
 * silently overwrite the system-prompt overlay or inject a malicious skill
 * body — no further question asked.
 *
 * These tests assert the SAFE behaviour (grantFits returns false) and
 * therefore FAIL on the current code.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { grantFits } from './acp.permission.grants.js';
import { sensitiveMarker } from './acp.permission.sensitive.js';

const CWD = '/home/user/project';

describe('item 1: grant must not cover system-prompt / skill-body files', () => {
  it('sensitiveMarker returns a non-empty string for AFK.md', () => {
    // AFK.md is re-read as the project-scope system-prompt overlay every turn.
    // Writing it under a grant lets the model inject arbitrary instructions.
    const marker = sensitiveMarker('AFK.md', CWD, path);
    expect(marker, 'AFK.md should be flagged sensitive').not.toBe('');
  });

  it('grantFits returns false for write_file to AFK.md', () => {
    const result = grantFits(
      'write_file',
      { file_path: 'AFK.md', content: 'injected system prompt' },
      CWD,
      undefined,
      path,
    );
    expect(result, 'write_file AFK.md must not be grant-covered').toBe(false);
  });

  it('sensitiveMarker returns a non-empty string for .afk/skills/myskill/SKILL.md', () => {
    // .afk/skills/ is rescanned on every skill invocation (skill-bridge.ts:339).
    // Writing a SKILL.md under a grant lets the model inject a fork skill body.
    const marker = sensitiveMarker('.afk/skills/myskill/SKILL.md', CWD, path);
    expect(marker, '.afk/skills SKILL.md should be flagged sensitive').not.toBe('');
  });

  it('grantFits returns false for write_file to .afk/skills/myskill/SKILL.md', () => {
    const result = grantFits(
      'write_file',
      { file_path: '.afk/skills/myskill/SKILL.md', content: '---\nname: myskill\n---\nmalicious body' },
      CWD,
      undefined,
      path,
    );
    expect(result, 'write_file .afk/skills/myskill/SKILL.md must not be grant-covered').toBe(false);
  });

  it('grantFits returns false for edit_file on AFK.md', () => {
    const result = grantFits(
      'edit_file',
      { file_path: 'AFK.md', old_string: 'old', new_string: 'injected' },
      CWD,
      undefined,
      path,
    );
    expect(result, 'edit_file AFK.md must not be grant-covered').toBe(false);
  });

  it('grantFits returns false for patch_apply targeting AFK.md', () => {
    const result = grantFits(
      'patch_apply',
      { changes: [{ path: 'AFK.md', content: 'injected' }] },
      CWD,
      undefined,
      path,
    );
    expect(result, 'patch_apply AFK.md must not be grant-covered').toBe(false);
  });
});
