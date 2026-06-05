import { describe, expect, it } from 'vitest';
import { checkToolPermission } from './permissions.js';

describe('checkToolPermission', () => {
  it('allows all tools when no config provided', () => {
    expect(checkToolPermission('read_file').allowed).toBe(true);
    expect(checkToolPermission('bash').allowed).toBe(true);
    expect(checkToolPermission('write_file').allowed).toBe(true);
    expect(checkToolPermission('edit_file').allowed).toBe(true);
    expect(checkToolPermission('unknown_tool').allowed).toBe(true);
  });

  it('restricts to allowlist when config provided', () => {
    const config = { allowedTools: ['bash', 'read_file'] };
    expect(checkToolPermission('bash', config).allowed).toBe(true);
    expect(checkToolPermission('read_file', config).allowed).toBe(true);
    expect(checkToolPermission('write_file', config).allowed).toBe(false);
  });

  it('includes a reason when denied by allowlist', () => {
    const config = { allowedTools: ['read_file'] };
    const result = checkToolPermission('bash', config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('bash');
  });

  it('allowlist is exclusive — unlisted tools are denied', () => {
    const config = { allowedTools: ['bash'] };
    expect(checkToolPermission('bash', config).allowed).toBe(true);
    expect(checkToolPermission('read_file', config).allowed).toBe(false);
  });
});
