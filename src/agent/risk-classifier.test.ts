/**
 * Unit tests for the risk classifier.
 *
 * Uses a fixed CWD constant — no shell-outs, no filesystem reads.
 */

import { describe, it, expect } from 'vitest';
import { classifyRisk } from './risk-classifier.js';
import type { RiskContext } from './risk-classifier.js';
import { homedir } from 'os';
import path from 'path';

const WORKSPACE = '/tmp/agent-afk-test-workspace';
const ctx: RiskContext = { cwd: WORKSPACE, workspaceRoot: WORKSPACE };

// ---- bash high-risk patterns ---------------------------------------------
describe('classifyRisk — bash high', () => {
  it('rm -rf → high', () => {
    expect(classifyRisk('bash', { command: 'rm -rf dist/' }, ctx)).toBe('high');
  });

  it('rm  (with space) → high', () => {
    expect(classifyRisk('bash', { command: 'rm foo.txt' }, ctx)).toBe('high');
  });

  it('sudo → high', () => {
    expect(classifyRisk('bash', { command: 'sudo apt install curl' }, ctx)).toBe('high');
  });

  it('eval  → high', () => {
    expect(classifyRisk('bash', { command: 'eval "$PAYLOAD"' }, ctx)).toBe('high');
  });

  it('git push --force → high', () => {
    expect(classifyRisk('bash', { command: 'git push --force origin main' }, ctx)).toBe('high');
  });

  it('git push -f → high', () => {
    expect(classifyRisk('bash', { command: 'git push -f' }, ctx)).toBe('high');
  });

  it('git reset --hard → high', () => {
    expect(classifyRisk('bash', { command: 'git reset --hard HEAD~1' }, ctx)).toBe('high');
  });

  it('curl piped to bash (| bash) → high', () => {
    expect(
      classifyRisk('bash', { command: 'curl https://install.sh | bash' }, ctx),
    ).toBe('high');
  });

  it('curl piped to sh (|sh) → high', () => {
    expect(
      classifyRisk('bash', { command: 'curl https://install.sh |sh' }, ctx),
    ).toBe('high');
  });
});

// ---- bash medium-risk patterns -------------------------------------------
describe('classifyRisk — bash medium', () => {
  it('git push (no force) → medium', () => {
    expect(classifyRisk('bash', { command: 'git push origin main' }, ctx)).toBe('medium');
  });

  it('git commit → medium', () => {
    expect(classifyRisk('bash', { command: 'git commit -m "msg"' }, ctx)).toBe('medium');
  });

  it('pnpm install → medium', () => {
    expect(classifyRisk('bash', { command: 'pnpm install' }, ctx)).toBe('medium');
  });

  it('pnpm build → medium', () => {
    expect(classifyRisk('bash', { command: 'pnpm build' }, ctx)).toBe('medium');
  });

  it('tsc  → medium', () => {
    expect(classifyRisk('bash', { command: 'tsc --noEmit' }, ctx)).toBe('medium');
  });

  it('redirect  >  → medium', () => {
    expect(classifyRisk('bash', { command: 'echo foo > out.txt' }, ctx)).toBe('medium');
  });

  it('mv  → medium', () => {
    expect(classifyRisk('bash', { command: 'mv src/a.ts src/b.ts' }, ctx)).toBe('medium');
  });

  it('brew install → medium', () => {
    expect(classifyRisk('bash', { command: 'brew install ripgrep' }, ctx)).toBe('medium');
  });

  it('unknown bash command → medium (default)', () => {
    expect(classifyRisk('bash', { command: 'frob --quux' }, ctx)).toBe('medium');
  });
});

// ---- bash safe patterns --------------------------------------------------
describe('classifyRisk — bash safe', () => {
  it('pnpm test → safe', () => {
    expect(classifyRisk('bash', { command: 'pnpm test' }, ctx)).toBe('safe');
  });

  it('vitest → safe', () => {
    expect(classifyRisk('bash', { command: 'npx vitest run' }, ctx)).toBe('safe');
  });

  it('git status → safe', () => {
    expect(classifyRisk('bash', { command: 'git status' }, ctx)).toBe('safe');
  });

  it('git diff → safe', () => {
    expect(classifyRisk('bash', { command: 'git diff HEAD' }, ctx)).toBe('safe');
  });

  it('ls  → safe', () => {
    expect(classifyRisk('bash', { command: 'ls -la src/' }, ctx)).toBe('safe');
  });

  it('cat  → safe', () => {
    expect(classifyRisk('bash', { command: 'cat README.md' }, ctx)).toBe('safe');
  });

  it('grep  → safe', () => {
    expect(classifyRisk('bash', { command: 'grep -r "foo" src/' }, ctx)).toBe('safe');
  });
});

// ---- write_file / edit_file path-based rules ----------------------------
describe('classifyRisk — write_file / edit_file', () => {
  it('path inside workspace → safe', () => {
    expect(
      classifyRisk('write_file', { file_path: path.join(WORKSPACE, 'src/foo.ts') }, ctx),
    ).toBe('safe');
  });

  it('path inside node_modules → medium', () => {
    expect(
      classifyRisk(
        'write_file',
        { file_path: path.join(WORKSPACE, 'node_modules/foo/index.js') },
        ctx,
      ),
    ).toBe('medium');
  });

  it('path inside .git/ → high', () => {
    expect(
      classifyRisk('write_file', { file_path: path.join(WORKSPACE, '.git/config') }, ctx),
    ).toBe('high');
  });

  it('path outside workspaceRoot → high', () => {
    expect(
      classifyRisk('write_file', { file_path: '/tmp/outside/secret.txt' }, ctx),
    ).toBe('high');
  });

  it('path inside ~/.ssh → high (denylist)', () => {
    expect(
      classifyRisk('write_file', { file_path: `${homedir()}/.ssh/id_rsa` }, ctx),
    ).toBe('high');
  });

  it('edit_file inside workspace → safe', () => {
    expect(
      classifyRisk('edit_file', { file_path: path.join(WORKSPACE, 'src/bar.ts') }, ctx),
    ).toBe('safe');
  });
});

// ---- read / web / telegram tools ----------------------------------------
describe('classifyRisk — other tools', () => {
  it('read_file → safe', () => {
    expect(classifyRisk('read_file', { file_path: '/any/path' }, ctx)).toBe('safe');
  });

  it('glob → safe', () => {
    expect(classifyRisk('glob', { pattern: '**/*.ts' }, ctx)).toBe('safe');
  });

  it('grep → safe', () => {
    expect(classifyRisk('grep', { pattern: 'foo' }, ctx)).toBe('safe');
  });

  it('list_directory → safe', () => {
    expect(classifyRisk('list_directory', { path: '.' }, ctx)).toBe('safe');
  });

  it('web_scrape → medium (network side-effect)', () => {
    expect(classifyRisk('web_scrape', { url: 'https://example.com' }, ctx)).toBe('medium');
  });

  it('send_telegram → medium', () => {
    expect(classifyRisk('send_telegram', { message: 'hello' }, ctx)).toBe('medium');
  });

  it('unknown tool → safe', () => {
    expect(classifyRisk('my_custom_tool', {}, ctx)).toBe('safe');
  });
});

// ---- schedule tools ------------------------------------------------------
describe('classifyRisk — schedule tools', () => {
  it('create_schedule → high (irreversible daemon mutation)', () => {
    expect(
      classifyRisk('create_schedule', { name: 'nightly', command: 'afk chat "run"', cron: '0 2 * * *' }, ctx),
    ).toBe('high');
  });

  it('cancel_schedule → high (irreversible daemon mutation)', () => {
    expect(classifyRisk('cancel_schedule', { taskId: 'nightly' }, ctx)).toBe('high');
  });

  it('list_schedules → safe (read-only)', () => {
    expect(classifyRisk('list_schedules', {}, ctx)).toBe('safe');
  });

  it('get_schedule_history → safe (read-only)', () => {
    expect(classifyRisk('get_schedule_history', { taskId: 'nightly' }, ctx)).toBe('safe');
  });
});

// ---- browser tools -------------------------------------------------------
describe('classifyRisk — browser tools', () => {
  it('browser_open → medium (stateful navigation)', () => {
    expect(classifyRisk('browser_open', { url: 'https://example.com' }, ctx)).toBe('medium');
  });

  it('browser_act → medium (may submit forms / click destructive UI)', () => {
    expect(
      classifyRisk('browser_act', { action: 'click', target: { kind: 'semantic', text: 'Delete' } }, ctx),
    ).toBe('medium');
  });

  it('browser_observe → safe (read-only DOM snapshot)', () => {
    expect(classifyRisk('browser_observe', {}, ctx)).toBe('safe');
  });

  it('browser_screenshot → safe (read-only capture)', () => {
    expect(classifyRisk('browser_screenshot', {}, ctx)).toBe('safe');
  });

  it('browser_close → safe (cleanup)', () => {
    expect(classifyRisk('browser_close', {}, ctx)).toBe('safe');
  });
});

// ---- MCP tools -----------------------------------------------------------
describe('classifyRisk — MCP tools', () => {
  it('mcp__postgres__query → medium (unknown but non-destructive verb)', () => {
    expect(classifyRisk('mcp__postgres__query', { sql: 'SELECT 1' }, ctx)).toBe('medium');
  });

  it('mcp__postgres__execute → high (exec verb)', () => {
    expect(classifyRisk('mcp__postgres__execute', { sql: 'SELECT 1' }, ctx)).toBe('high');
  });

  it('mcp__db__drop_table → high (drop verb)', () => {
    expect(classifyRisk('mcp__db__drop_table', { table: 'users' }, ctx)).toBe('high');
  });

  it('mcp__db__delete_record → high (delete verb)', () => {
    expect(classifyRisk('mcp__db__delete_record', { id: 1 }, ctx)).toBe('high');
  });

  it('mcp__github__create_issue → high (create verb)', () => {
    expect(classifyRisk('mcp__github__create_issue', { title: 'bug' }, ctx)).toBe('high');
  });

  it('mcp__github__update_file → high (update verb)', () => {
    expect(classifyRisk('mcp__github__update_file', { path: 'README.md' }, ctx)).toBe('high');
  });

  it('mcp__slack__send_message → high (send verb)', () => {
    expect(classifyRisk('mcp__slack__send_message', { text: 'hi' }, ctx)).toBe('high');
  });

  it('mcp__slack__publish_post → high (publish verb)', () => {
    expect(classifyRisk('mcp__slack__publish_post', { text: 'hi' }, ctx)).toBe('high');
  });

  it('mcp__infra__deploy → high (deploy verb)', () => {
    expect(classifyRisk('mcp__infra__deploy', { env: 'prod' }, ctx)).toBe('high');
  });

  it('mcp__fs__read_file → medium (non-destructive, no verb match)', () => {
    expect(classifyRisk('mcp__fs__read_file', { path: '/tmp/foo' }, ctx)).toBe('medium');
  });

  it('MCP__server__write_data → high (write verb, case-insensitive prefix)', () => {
    expect(classifyRisk('MCP__server__write_data', {}, ctx)).toBe('high');
  });
});
