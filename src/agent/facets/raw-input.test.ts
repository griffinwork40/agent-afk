import { describe, it, expect } from 'vitest';
import { extractRawToolInput, RAW_INPUT_FIELDS, RAW_INPUT_FIELD_CAP } from './raw-input.js';

describe('extractRawToolInput', () => {
  it('keeps exactly the whitelisted scalar fields derivation reads', () => {
    const raw = extractRawToolInput({
      command: 'git commit -m "x"',
      file_path: '/src/a.ts',
      name: 'review',
      id_prefix: 'verify',
    });
    expect(raw).toBeDefined();
    // `command` is intentionally excluded (secret-at-rest risk); the rest are kept.
    expect(JSON.parse(raw as string)).toEqual({
      file_path: '/src/a.ts',
      name: 'review',
      id_prefix: 'verify',
    });
    // The whitelist is the documented contract — `command` is not in it.
    expect([...RAW_INPUT_FIELDS]).toEqual(['file_path', 'name', 'id_prefix']);
  });

  it('drops large/sensitive fields (command, content, new_string, old_string, value)', () => {
    const raw = extractRawToolInput({
      file_path: '/src/secret.ts',
      command: 'curl -H "Authorization: Bearer sk-leaked-bash-secret" https://api.example.com',
      content: 'API_KEY=sk-supersecret-value',
      new_string: 'token = "sk-leaked-edit"',
      old_string: 'previous',
      value: 'hunter2-password',
    });
    expect(JSON.parse(raw as string)).toEqual({ file_path: '/src/secret.ts' });
    // Secrets carried by the dropped fields — including a bash `command` — never reach the serialized form.
    expect(raw).not.toContain('sk-leaked-bash-secret');
    expect(raw).not.toContain('sk-supersecret');
    expect(raw).not.toContain('sk-leaked-edit');
    expect(raw).not.toContain('hunter2-password');
  });

  it('caps a pathologically large field value', () => {
    const huge = 'x'.repeat(RAW_INPUT_FIELD_CAP + 5_000);
    const raw = extractRawToolInput({ file_path: huge });
    const parsed = JSON.parse(raw as string) as { file_path: string };
    expect(parsed.file_path.length).toBe(RAW_INPUT_FIELD_CAP);
  });

  it('returns undefined when no whitelisted field is present', () => {
    expect(extractRawToolInput({ content: 'x', value: 'y' })).toBeUndefined();
    expect(extractRawToolInput({})).toBeUndefined();
  });

  it('returns undefined for non-object inputs', () => {
    expect(extractRawToolInput('not-an-object')).toBeUndefined();
    expect(extractRawToolInput(null)).toBeUndefined();
    expect(extractRawToolInput(undefined)).toBeUndefined();
    expect(extractRawToolInput(42)).toBeUndefined();
  });
});
