import { describe, it, expect } from 'vitest';
import { toolSummary } from './tool-summary';

describe('toolSummary', () => {
  it.each(['read_file', 'edit_file', 'write_file'])('shows distinct cwd-relative %s paths', name => {
    expect(toolSummary(name, '{"file_path":"/repo/a/config.ts"}', '/repo')).toBe('a/config.ts');
    expect(toolSummary(name, ' /repo/b/config.ts', '/repo/')).toBe('b/config.ts');
    expect(toolSummary(name, '/repository/a.ts', '/repo')).toBe('/repository/a.ts');
    expect(toolSummary(name, 'C:\\repo\\a.ts', 'C:\\repo')).toBe('a.ts');
  });
  it.each([
    ['bash', '{"command":"echo first\\necho second"}', 'echo first'],
    ['glob', '{"pattern":"**/*.ts"}', 'glob "**/*.ts"'],
    ['web_request', '{"url":"https://example.com/path"}', 'example.com'],
    ['web_scrape', 'https://example.com/path', 'example.com'],
    ['web_scrape', '{"query":"test search"}', 'test search'],
    ['agent', '{"prompt":"Investigate the renderer\\nCarefully"}', 'Investigate the renderer'],
    ['unknown', ' raw preview ', 'raw preview'],
    ['read_file', '{"file_path":', '{"file_path":'],
    ['bash', 'echo first\necho second', 'echo first'],
    ['read_file', 'null', 'null'],
  ])('summarizes %s %s', (name, input, expected) => expect(toolSummary(name, input)).toBe(expected));

  it('grep with path shows pattern and relative dir', () => {
    expect(toolSummary('grep', '{"pattern":"MAX_TEXT_LEN","path":"/repo/src"}', '/repo')).toBe('grep "MAX_TEXT_LEN" in src');
    expect(toolSummary('grep', '{"pattern":"foo|bar"}', '/repo')).toBe('grep "foo|bar"');
    expect(toolSummary('grep', '{"pattern":"foo","path":"/repo"}', '/repo')).toBe('grep "foo" in .');
    expect(toolSummary('grep', '{"pattern":"X","include":"*.ts"}', '/repo')).toBe('grep "X" in *.ts');
  });
  it('grep legacy plain-text preview passes through unchanged', () => {
    expect(toolSummary('grep', 'MAX_TEXT_LEN')).toBe('MAX_TEXT_LEN');
  });
});

describe('toolSummary: formatted grep/glob ledger previews', () => {
  it('shows the pattern and a repo-relative dir', () => {
    expect(toolSummary('grep', ' "MAX_TEXT_LEN" in /repo/src/agent', '/repo')).toBe('grep "MAX_TEXT_LEN" in src/agent');
    expect(toolSummary('grep', ' "TODO" in /repo', '/repo')).toBe('grep "TODO" in .');
    expect(toolSummary('glob', ' "**/*.ts"', '/repo')).toBe('glob "**/*.ts"');
  });
});
