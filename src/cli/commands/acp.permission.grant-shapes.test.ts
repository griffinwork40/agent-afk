/** Red team 2b: grant-shape attempts that HELD on 6f18f96c7 (evidence for the report). */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { grantFits } from './acp.permission.grants.js';

const CWD = path.resolve('/workspace/proj');
const CHILD = path.resolve('/workspace/proj/sub');

describe('redteam2b grant shapes (held)', () => {
  const refused: Array<[string, Record<string, unknown>, string?]> = [
    ['write_file', { file_path: ['a.txt'], content: 'x' }],
    ['write_file', { file_path: 1, content: 'x' }],
    ['write_file', { file_path: '', content: 'x' }],
    ['write_file', { file_path: '~/x', content: 'x' }],
    ['write_file', { file_path: 'a\u0000b', content: 'x' }],
    ['write_file', { file_path: '..//../etc/passwd', content: 'x' }],
    ['write_file', { file_path: 'a/../../x', content: 'x' }],
    ['write_file', { file_path: '/WORKSPACE/proj/../x', content: 'x' }],
    ['write_file', { file_path: 'a.txt', content: 'x', path: '/etc/passwd' }],
    ['write_file', JSON.parse('{"file_path":"a.txt","content":"x","__proto__":{"file_path":"/etc/x"}}')],
    ['edit_file', { file_path: 'a', old_string: 'a', new_string: 'b', cwd: '/' }],
    ['patch_apply', { changes: [{ path: 'a', content: 'x', cwd: '/' }] }],
    ['patch_apply', { changes: [{ path: ['a'], content: 'x' }] }],
    ['patch_apply', { changes: [[{ path: '/etc/x' }]] }],
    ['patch_apply', { changes: { 0: { path: 'a' } } }],
    ['patch_apply', { changes: [{ path: 'a' }, { path: '../x' }] }],
    ['patch_apply', { changes: [{ path: 'a' }], root: '/' }],
  ];
  for (const [tool, input, caller] of refused) {
    it(`${tool} ${JSON.stringify(input)} is not covered`, () => {
      expect(grantFits(tool, input, CWD, caller)).toBe(false);
    });
  }
  it('a child base inside the session resolves .. against the child and is still contained', () => {
    expect(grantFits('patch_apply', { changes: [{ path: '../x' }] }, CWD, CHILD)).toBe(true);
    expect(grantFits('patch_apply', { changes: [{ path: '../../x' }] }, CWD, CHILD)).toBe(false);
    expect(grantFits('write_file', { file_path: 'x', content: '' }, CWD, path.resolve('/elsewhere'))).toBe(false);
  });
});
