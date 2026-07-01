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

  it('cancel_schedule → high (mutates daemon cron store)', () => {
    // Reversible at its default (enabled:false); only { permanent:true } removes
    // it. Still 'high' — a silently disabled schedule is a notable daemon change.
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

  // --- 2-segment names (no server component) --------------------------------
  // Regression: PR #339 extracted the sub-name with `.split('__').slice(2)`,
  // which dropped everything for a 2-segment `mcp__<verb>` name → empty sub-name
  // → destructive-verb scan never fired → rated 'medium' (allowed unattended).
  // The gate MUST rate these 'high'. Guards the exact bypass the review flagged.
  it('mcp__deploy → high (2-segment destructive name — no server component)', () => {
    expect(classifyRisk('mcp__deploy', { env: 'prod' }, ctx)).toBe('high');
  });

  it('mcp__delete → high (2-segment destructive name)', () => {
    expect(classifyRisk('mcp__delete', { id: 1 }, ctx)).toBe('high');
  });

  it('mcp__exec → high (2-segment destructive name)', () => {
    expect(classifyRisk('mcp__exec', { cmd: 'ls' }, ctx)).toBe('high');
  });

  it('mcp__drop → high (2-segment destructive name)', () => {
    expect(classifyRisk('mcp__drop', { table: 'users' }, ctx)).toBe('high');
  });

  it('mcp__reset → high (2-segment destructive name — review example)', () => {
    expect(classifyRisk('mcp__reset', {}, ctx)).toBe('high');
  });

  it('mcp__query → medium (2-segment, non-destructive)', () => {
    expect(classifyRisk('mcp__query', { sql: 'SELECT 1' }, ctx)).toBe('medium');
  });

  it('mcp__status → medium (2-segment, non-destructive)', () => {
    expect(classifyRisk('mcp__status', {}, ctx)).toBe('medium');
  });

  // --- extended destructive verbs -------------------------------------------
  // Realistic destructive operations the original verb list missed; all run
  // unattended at 'medium' before this change. Financial, infra-lifecycle,
  // repo, auth, and storage mutations must gate 'high'.
  it('mcp__payments__charge → high (financial mutation)', () => {
    expect(classifyRisk('mcp__payments__charge', { amount: 100 }, ctx)).toBe('high');
  });

  it('mcp__billing__refund → high (financial mutation)', () => {
    expect(classifyRisk('mcp__billing__refund', { id: 'txn_1' }, ctx)).toBe('high');
  });

  it('mcp__github__merge_pr → high (irreversible repo write)', () => {
    expect(classifyRisk('mcp__github__merge_pr', { number: 7 }, ctx)).toBe('high');
  });

  it('mcp__aws__terminate_instance → high (infra destruction)', () => {
    expect(classifyRisk('mcp__aws__terminate_instance', { id: 'i-123' }, ctx)).toBe('high');
  });

  it('mcp__auth__revoke_token → high (access revocation)', () => {
    expect(classifyRisk('mcp__auth__revoke_token', { token: 'x' }, ctx)).toBe('high');
  });

  it('mcp__infra__provision_cluster → high (infra lifecycle)', () => {
    expect(classifyRisk('mcp__infra__provision_cluster', {}, ctx)).toBe('high');
  });

  it('mcp__k8s__scale_deployment → high (infra lifecycle)', () => {
    expect(classifyRisk('mcp__k8s__scale_deployment', { replicas: 0 }, ctx)).toBe('high');
  });

  it('mcp__storage__wipe_bucket → high (storage destruction)', () => {
    expect(classifyRisk('mcp__storage__wipe_bucket', { bucket: 'b' }, ctx)).toBe('high');
  });

  it('mcp__flags__disable_feature → high (state change)', () => {
    expect(classifyRisk('mcp__flags__disable_feature', { flag: 'f' }, ctx)).toBe('high');
  });

  it('mcp__db__rollback_migration → high (rollback verb)', () => {
    expect(classifyRisk('mcp__db__rollback_migration', {}, ctx)).toBe('high');
  });

  it('mcp__fs__rename_file → high (rename verb)', () => {
    expect(classifyRisk('mcp__fs__rename_file', { from: 'a', to: 'b' }, ctx)).toBe('high');
  });

  // --- word-boundary matching (no substring false positives) ----------------
  // Substring `.includes()` wrongly gated these 'high' ('run' ⊂ 'runner',
  // 'exec' ⊂ 'executor'). Token matching on `_`/`-` boundaries keeps whole-word
  // verbs and lets these benign read-ish tools through as 'medium'.
  it('mcp__test__runner → medium (runner is not the verb "run")', () => {
    expect(classifyRisk('mcp__test__runner', {}, ctx)).toBe('medium');
  });

  it('mcp__server__executor → medium (executor is not the verb "exec")', () => {
    expect(classifyRisk('mcp__server__executor', {}, ctx)).toBe('medium');
  });

  it('mcp__shell__run → high (run is a whole-word verb here)', () => {
    expect(classifyRisk('mcp__shell__run', { cmd: 'ls' }, ctx)).toBe('high');
  });

  it('mcp__postgres__list_tables → medium (server "postgres" contains "post" but token match avoids the false positive)', () => {
    // Correctness guard: since the scan now includes the server segment, a raw
    // `.includes('post')` would wrongly gate every mcp__postgres__* tool 'high'.
    // Token matching on word boundaries keeps `postgres` distinct from `post`.
    expect(classifyRisk('mcp__postgres__list_tables', {}, ctx)).toBe('medium');
  });

  // --- mixed-case prefix ----------------------------------------------------
  // The prefix test uses the already-lowercased tool name, so mixed-case
  // `Mcp__…` is classified (not silently dropped to the 'safe' default).
  it('Mcp__server__delete_record → high (mixed-case prefix classified)', () => {
    expect(classifyRisk('Mcp__server__delete_record', { id: 1 }, ctx)).toBe('high');
  });
});
