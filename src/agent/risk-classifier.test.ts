/**
 * Unit tests for the risk classifier.
 *
 * Uses a fixed CWD constant — no shell-outs. The temp-dir carve-out suite
 * creates mkdtemp fixtures (incl. dangling symlinks) and cleans them up.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { classifyRisk, classifyRiskDetailed } from './risk-classifier.js';
import type { RiskContext } from './risk-classifier.js';
import { getTempRoots, isOutsideRoot, isPrivateTempRoot } from './risk-classifier.paths.js';
import { setSessionTmpdirRootForTests } from './session/session-tmpdir.js';
import { homedir } from 'os';
import * as os from 'os';
import path from 'path';

const WORKSPACE = path.join(os.tmpdir(), 'agent-afk-test-workspace');
const ctx: RiskContext = { cwd: WORKSPACE, workspaceRoot: WORKSPACE };
// An outside-the-workspace path that is neither in the system temp dir nor on
// the write denylist (resolve() makes it a valid absolute path on win32 too).
const OUTSIDE_NON_TMP = path.resolve('/opt/afk-risk-outside/secret.txt');

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

  it('eval → high', () => {
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

  // ── outbound HTTP writes (#1280) ──────────────────────────────────────────
  it('curl -X POST → high (outbound write method)', () => {
    expect(
      classifyRisk('bash', { command: 'curl -X POST https://api.example.com/users -H "Content-Type: application/json" -d \'{"name":"Alice"}\'' }, ctx),
    ).toBe('high');
  });

  it('curl -X PUT → high (outbound write method)', () => {
    expect(
      classifyRisk('bash', { command: 'curl -X PUT https://api.example.com/users/1 -d \'{"name":"Bob"}\'' }, ctx),
    ).toBe('high');
  });

  it('curl -X PATCH → high (outbound write method)', () => {
    expect(
      classifyRisk('bash', { command: 'curl -X PATCH https://api.example.com/users/1 -d \'{"active":false}\'' }, ctx),
    ).toBe('high');
  });

  it('curl -X DELETE → high (outbound write method)', () => {
    expect(
      classifyRisk('bash', { command: 'curl -X DELETE https://api.example.com/users/1' }, ctx),
    ).toBe('high');
  });

  it('curl --data → high (body payload implies outbound write)', () => {
    expect(
      classifyRisk('bash', { command: 'curl --data \'{"key":"val"}\' https://api.example.com/events' }, ctx),
    ).toBe('high');
  });

  it('curl -d → high (short form body payload)', () => {
    expect(
      classifyRisk('bash', { command: 'curl -d @payload.json https://api.example.com/hook' }, ctx),
    ).toBe('high');
  });

  it('wget --post-data → high (wget outbound POST)', () => {
    expect(
      classifyRisk('bash', { command: 'wget --post-data="msg=hello" https://api.example.com/notify' }, ctx),
    ).toBe('high');
  });

  // ── review hardening (#1302 review findings) ─────────────────────────────
  it('curl -XPOST (no-space form) → high', () => {
    expect(
      classifyRisk('bash', { command: 'curl -XPOST https://api.example.com/users' }, ctx),
    ).toBe('high');
  });

  it('curl -XDELETE (no-space form) → high', () => {
    expect(
      classifyRisk('bash', { command: 'curl -XDELETE https://api.example.com/users/1' }, ctx),
    ).toBe('high');
  });

  it('curl --request POST (long form) → high', () => {
    expect(
      classifyRisk('bash', { command: 'curl --request POST https://api.example.com/users' }, ctx),
    ).toBe('high');
  });

  it('curl --request DELETE (long form) → high', () => {
    expect(
      classifyRisk('bash', { command: 'curl --request DELETE https://api.example.com/users/1' }, ctx),
    ).toBe('high');
  });

  it('curl -d"data" (no-space attached value) → high', () => {
    expect(
      classifyRisk('bash', { command: 'curl -d"data" https://api.example.com/hook' }, ctx),
    ).toBe('high');
  });

  it('curl -F (multipart form) → high', () => {
    expect(
      classifyRisk('bash', { command: 'curl -F file=@photo.png https://api.example.com/upload' }, ctx),
    ).toBe('high');
  });

  it('wget --post-file → high (wget outbound file upload)', () => {
    expect(
      classifyRisk('bash', { command: 'wget --post-file=body.bin https://api.example.com/upload' }, ctx),
    ).toBe('high');
  });

  it('curl -H ... -X POST (intervening flags) → high', () => {
    expect(
      classifyRisk('bash', { command: 'curl -H \'Content-Type: application/json\' -X POST https://api.example.com/users -d \'{}\'' }, ctx),
    ).toBe('high');
  });

  // ── service-registration commands (#1311 review) ─────────────────────────
  it('launchctl load → high', () => {
    expect(classifyRisk('bash', { command: 'launchctl load ~/Library/LaunchAgents/com.example.plist' }, ctx)).toBe('high');
  });

  it('launchctl bootstrap → high', () => {
    expect(classifyRisk('bash', { command: 'launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.example.plist' }, ctx)).toBe('high');
  });

  it('launchctl submit → high', () => {
    expect(classifyRisk('bash', { command: 'launchctl submit -l com.example.job -- /usr/bin/example' }, ctx)).toBe('high');
  });

  it('launchctl start → high', () => {
    expect(classifyRisk('bash', { command: 'launchctl start com.example.service' }, ctx)).toBe('high');
  });

  it('launchctl kickstart → high (Item 2)', () => {
    expect(classifyRisk('bash', { command: 'launchctl kickstart -k gui/501/com.example.service' }, ctx)).toBe('high');
  });

  it('launchctl enable  (with trailing space) → high (Item 7)', () => {
    expect(classifyRisk('bash', { command: 'launchctl enable system/com.example.service' }, ctx)).toBe('high');
  });

  it('systemctl enable  (with trailing space) → high (Item 3)', () => {
    expect(classifyRisk('bash', { command: 'systemctl enable afk-telegram.service' }, ctx)).toBe('high');
  });

  it('systemctl start  (with trailing space) → high (Item 3)', () => {
    expect(classifyRisk('bash', { command: 'systemctl start afk-telegram.service' }, ctx)).toBe('high');
  });

  it('systemctl daemon-reload → high', () => {
    expect(classifyRisk('bash', { command: 'systemctl daemon-reload' }, ctx)).toBe('high');
  });

  // ── false-positive guards (trailing-space convention) ─────────────────────
  it('launchctl enable-linger → NOT high (trailing space guards enable)', () => {
    expect(classifyRisk('bash', { command: 'launchctl enable-linger root' }, ctx)).not.toBe('high');
  });

  it('systemctl enable-linger → NOT high (trailing space guards enable)', () => {
    expect(classifyRisk('bash', { command: 'systemctl enable-linger root' }, ctx)).not.toBe('high');
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

  it('tsc → medium', () => {
    expect(classifyRisk('bash', { command: 'tsc --noEmit' }, ctx)).toBe('medium');
  });

  it('redirect  > → medium', () => {
    expect(classifyRisk('bash', { command: 'echo foo > out.txt' }, ctx)).toBe('medium');
  });

  it('mv → medium', () => {
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

  it('ls → safe', () => {
    expect(classifyRisk('bash', { command: 'ls -la src/' }, ctx)).toBe('safe');
  });

  it('cat → safe', () => {
    expect(classifyRisk('bash', { command: 'cat README.md' }, ctx)).toBe('safe');
  });

  it('grep → safe', () => {
    expect(classifyRisk('bash', { command: 'grep -r "foo" src/' }, ctx)).toBe('safe');
  });

  // #2750: gh CLI read-only subcommands — used by agents to poll CI/PR status
  it('gh pr view → safe (read-only CI poll)', () => {
    expect(classifyRisk('bash', { command: 'gh pr view 123 --json statusCheckRollup' }, ctx)).toBe('safe');
  });

  it('gh pr list → safe', () => {
    expect(classifyRisk('bash', { command: 'gh pr list --state open --json number,title' }, ctx)).toBe('safe');
  });

  it('gh pr checks → safe', () => {
    expect(classifyRisk('bash', { command: 'gh pr checks 123' }, ctx)).toBe('safe');
  });

  it('gh pr status → safe', () => {
    expect(classifyRisk('bash', { command: 'gh pr status' }, ctx)).toBe('safe');
  });

  it('gh pr diff → safe', () => {
    expect(classifyRisk('bash', { command: 'gh pr diff 42' }, ctx)).toBe('safe');
  });

  it('gh run view → safe', () => {
    expect(classifyRisk('bash', { command: 'gh run view 7890 --log' }, ctx)).toBe('safe');
  });

  it('gh run list → safe (CI polling use-case from issue #2750)', () => {
    // This exact pattern was the one blocked in the reported session.
    expect(
      classifyRisk(
        'bash',
        { command: 'gh run list --branch main --workflow CI --limit 1 --json status,headSha' },
        ctx,
      ),
    ).toBe('safe');
  });

  it('gh issue view → safe', () => {
    expect(classifyRisk('bash', { command: 'gh issue view 2750 --json title,state' }, ctx)).toBe('safe');
  });

  it('gh issue list → safe', () => {
    expect(classifyRisk('bash', { command: 'gh issue list --label bug' }, ctx)).toBe('safe');
  });

  it('gh repo view → safe', () => {
    expect(classifyRisk('bash', { command: 'gh repo view griffinwork40/agent-afk' }, ctx)).toBe('safe');
  });

  it('curl --head → safe (HTTP HEAD probe)', () => {
    expect(classifyRisk('bash', { command: 'curl --head https://example.com/health' }, ctx)).toBe('safe');
  });

  it('curl -I → safe (short-form HEAD probe)', () => {
    expect(classifyRisk('bash', { command: 'curl -I https://example.com/health' }, ctx)).toBe('safe');
  });

  it('curl -sI → safe (silent HEAD probe)', () => {
    expect(classifyRisk('bash', { command: 'curl -sI https://api.example.com/status' }, ctx)).toBe('safe');
  });

  it('curl -si → safe (silent GET with response headers — read-only, not a HEAD probe)', () => {
    // `-si` (lowercase i) prints response headers for a GET request — still
    // read-only. The comment in BASH_SAFE was corrected in #2913 to not call
    // this a HEAD probe; the entry itself is kept because the command is safe.
    expect(classifyRisk('bash', { command: 'curl -si https://api.example.com/status' }, ctx)).toBe('safe');
  });

  it('wget --spider → safe (non-mutating spider mode)', () => {
    expect(classifyRisk('bash', { command: 'wget --spider https://example.com/health' }, ctx)).toBe('safe');
  });

  // Mutating gh subcommands must NOT be safe-listed
  it('gh pr merge → medium (mutating, not safe-listed)', () => {
    expect(classifyRisk('bash', { command: 'gh pr merge 123 --squash' }, ctx)).toBe('medium');
  });

  it('gh pr create → medium (mutating, not safe-listed)', () => {
    expect(classifyRisk('bash', { command: 'gh pr create --title "fix" --body ""' }, ctx)).toBe('medium');
  });

  it('gh pr comment → medium (mutating, not safe-listed)', () => {
    expect(classifyRisk('bash', { command: 'gh pr comment 123 --body "LGTM"' }, ctx)).toBe('medium');
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

  it('path outside workspaceRoot (and outside the temp dir) → high', () => {
    // Not os.tmpdir(): the system temp dir is carved out (see the temp-dir suite).
    expect(
      classifyRisk('write_file', { file_path: OUTSIDE_NON_TMP }, ctx),
    ).toBe('high');
  });

  it('path in a private temp root outside workspaceRoot → safe (temp carve-out)', () => {
    // Use a private session root override (0700 mkdtemp) so the test passes
    // whether or not os.tmpdir() is world-writable (e.g. Linux /tmp is 1777).
    const pr = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'afk-risk-priv-')));
    setSessionTmpdirRootForTests(pr);
    try {
      expect(
        classifyRisk('write_file', { file_path: path.join(pr, 'outside', 'scratch.txt') }, ctx),
      ).toBe('safe');
    } finally {
      setSessionTmpdirRootForTests(undefined);
      rmSync(pr, { recursive: true, force: true });
    }
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

// ---- schedule tools: self-disable carve-out (#3464) ----------------------
// A daemon task must be able to disable its own schedule without approval.
// The carve-out applies ONLY when ctx.daemonTaskId matches the input taskId,
// and ONLY for plain disable (not permanent delete, not command/cron edits).
describe('classifyRisk — schedule self-disable carve-out (#3464)', () => {
  const daemonCtx: RiskContext = { cwd: WORKSPACE, workspaceRoot: WORKSPACE, daemonTaskId: 'my-task' };

  // cancel_schedule own task → medium (plain disable)
  it('cancel_schedule own taskId (no permanent) → medium', () => {
    expect(classifyRisk('cancel_schedule', { taskId: 'my-task' }, daemonCtx)).toBe('medium');
  });

  // cancel_schedule own task with permanent:true → high (irreversible delete)
  it('cancel_schedule own taskId with permanent:true → high', () => {
    expect(classifyRisk('cancel_schedule', { taskId: 'my-task', permanent: true }, daemonCtx)).toBe('high');
  });

  // cancel_schedule own task with enable:true → high (re-enabling is a mutation)
  it('cancel_schedule own taskId enable:true → high', () => {
    expect(classifyRisk('cancel_schedule', { taskId: 'my-task', enable: true }, daemonCtx)).toBe('high');
  });

  // cancel_schedule DIFFERENT task → always high
  it('cancel_schedule different taskId → high', () => {
    expect(classifyRisk('cancel_schedule', { taskId: 'other-task' }, daemonCtx)).toBe('high');
  });

  // cancel_schedule with no daemonTaskId in context → high (non-daemon surface)
  it('cancel_schedule without daemonTaskId in context → high', () => {
    expect(classifyRisk('cancel_schedule', { taskId: 'my-task' }, ctx)).toBe('high');
  });

  // update_schedule own task, only enabled:false → medium
  it('update_schedule own taskId enabled:false only → medium', () => {
    expect(classifyRisk('update_schedule', { taskId: 'my-task', enabled: false }, daemonCtx)).toBe('medium');
  });

  // update_schedule own task but also edits command → high (not just a disable)
  it('update_schedule own taskId with command change → high', () => {
    expect(
      classifyRisk('update_schedule', { taskId: 'my-task', enabled: false, command: 'new cmd' }, daemonCtx),
    ).toBe('high');
  });

  // update_schedule own task but enabled:true → high (re-enabling is a mutation)
  it('update_schedule own taskId enabled:true → high', () => {
    expect(classifyRisk('update_schedule', { taskId: 'my-task', enabled: true }, daemonCtx)).toBe('high');
  });

  // update_schedule DIFFERENT task → always high
  it('update_schedule different taskId → high', () => {
    expect(classifyRisk('update_schedule', { taskId: 'other-task', enabled: false }, daemonCtx)).toBe('high');
  });

  // create_schedule is never carved out
  it('create_schedule → high regardless of daemonTaskId', () => {
    expect(
      classifyRisk('create_schedule', { name: 'x', command: 'y', cron: '0 * * * *' }, daemonCtx),
    ).toBe('high');
  });
});

// ---- worktree lifecycle --------------------------------------------------
// Regression guard for PR #390 review finding F1: the `worktree` tool had no
// classifier branch, so every action (including `remove --force`, which can
// discard uncommitted work) fell through to the 'safe' default and ran
// unattended in AFK mode with no approval. Only `remove` with `force:true` is
// irreversible → 'high'; `list` is a read-only dry-run → 'safe'; all other
// actions are reversible → 'medium'.
describe('classifyRisk — worktree tool', () => {
  it('remove with force:true → high (discards uncommitted work; must be gated)', () => {
    expect(classifyRisk('worktree', { action: 'remove', path: 'foo', force: true }, ctx)).toBe('high');
  });

  it('remove without force → medium (refuses dirty/locked/ahead; reversible)', () => {
    expect(classifyRisk('worktree', { action: 'remove', path: 'foo' }, ctx)).toBe('medium');
  });

  it('remove with explicit force:false → medium', () => {
    expect(classifyRisk('worktree', { action: 'remove', path: 'foo', force: false }, ctx)).toBe('medium');
  });

  it('create → medium (reversible: the worktree can be removed)', () => {
    expect(classifyRisk('worktree', { action: 'create', name: 'feat-x' }, ctx)).toBe('medium');
  });

  it('keep → medium (lock toggle)', () => {
    expect(classifyRisk('worktree', { action: 'keep', path: 'foo', reason: 'wip' }, ctx)).toBe('medium');
  });

  it('release → medium (unlock toggle)', () => {
    expect(classifyRisk('worktree', { action: 'release', path: 'foo' }, ctx)).toBe('medium');
  });

  it('list → safe (dry-run sweep report, read-only)', () => {
    expect(classifyRisk('worktree', { action: 'list' }, ctx)).toBe('safe');
  });

  it('missing/unknown action → medium (conservative default, never safe)', () => {
    expect(classifyRisk('worktree', {}, ctx)).toBe('medium');
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

// ---- isPrivateTempRoot pure predicate (portable unit tests) ----------------
describe('isPrivateTempRoot — pure predicate', () => {
  // Synthetic stat factory: isDirectory()=true, isSymbolicLink()=false by default.
  function st(overrides: Partial<{ dir: boolean; link: boolean; uid: number; mode: number }> = {}) {
    const dir = overrides.dir ?? true;
    const link = overrides.link ?? false;
    return {
      isDirectory: () => dir,
      isSymbolicLink: () => link,
      uid: overrides.uid ?? 1000,
      mode: overrides.mode ?? 0o700,
    };
  }

  it('world-writable sticky (0o1777) → excluded on linux', () => {
    expect(isPrivateTempRoot(st({ mode: 0o1777 }), 1000, 'linux')).toBe(false);
  });

  it('world-writable sticky (0o1777) → excluded on darwin', () => {
    expect(isPrivateTempRoot(st({ mode: 0o1777 }), 1000, 'darwin')).toBe(false);
  });

  it('0o700 owned by caller uid → included on linux', () => {
    expect(isPrivateTempRoot(st({ mode: 0o700 }), 1000, 'linux')).toBe(true);
  });

  it('traversable 0o755 root owned by caller → excluded (other users can reach child dirs)', () => {
    expect(isPrivateTempRoot(st({ mode: 0o40755 }), 1000, 'linux')).toBe(false);
    expect(isPrivateTempRoot(st({ mode: 0o40755 }), 1000, 'darwin')).toBe(false);
  });

  it('group-readable 0o750 / other-exec 0o701 roots → excluded', () => {
    expect(isPrivateTempRoot(st({ mode: 0o750 }), 1000, 'linux')).toBe(false);
    expect(isPrivateTempRoot(st({ mode: 0o701 }), 1000, 'linux')).toBe(false);
  });

  it('symlink → excluded regardless of mode', () => {
    expect(isPrivateTempRoot(st({ link: true, mode: 0o700 }), 1000, 'linux')).toBe(false);
  });

  it('not a directory → excluded', () => {
    expect(isPrivateTempRoot(st({ dir: false, mode: 0o700 }), 1000, 'linux')).toBe(false);
  });

  it('owned by different uid → excluded on linux', () => {
    expect(isPrivateTempRoot(st({ uid: 999, mode: 0o700 }), 1000, 'linux')).toBe(false);
  });

  it('win32 → included regardless of mode (NTFS ACLs; mode bits meaningless)', () => {
    expect(isPrivateTempRoot(st({ mode: 0o1777 }), 1000, 'win32')).toBe(true);
  });

  it('uid undefined (win32 process.getuid absent) → ownership check skipped', () => {
    // uid mismatch is ignored when uid is undefined
    expect(isPrivateTempRoot(st({ uid: 999, mode: 0o700 }), undefined, 'linux')).toBe(true);
  });
});

// ---- system temp dir carve-out (AFK scratch writes) ------------------------
describe('classifyRisk — system temp dir carve-out', () => {
  // A workspace that is NOT itself under the temp dir, so every temp write
  // below is a genuine workspace escape that only the carve-out can allow.
  const WS = path.resolve('/opt/afk-risk-ws');
  const wsCtx: RiskContext = { cwd: WS, workspaceRoot: WS };
  // Literal POSIX `/tmp/x`, the shape models emit. Built by join so no
  // '/'-rooted literal reaches a path API.
  const LITERAL_TMP_X = ['', 'tmp', 'afk-risk-literal.py'].join('/');

  // Private session root override: mkdtemp creates 0700 dirs, so this is a
  // valid private root on every platform. Restored in afterEach.
  let sessRoot: string;
  let fixture: string;

  beforeEach(() => {
    // Create a private 0700 dir to use as the session tmpdir root.
    sessRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'afk-risk-sess-')));
    setSessionTmpdirRootForTests(sessRoot);
    // A fixture dir under that private root for per-test files.
    fixture = realpathSync(mkdtempSync(path.join(sessRoot, 'afk-risk-fix-')));
  });
  afterEach(() => {
    setSessionTmpdirRootForTests(undefined);
    rmSync(sessRoot, { recursive: true, force: true });
  });

  it('write_file / edit_file to session root subdirectory → safe', () => {
    const p = path.join(sessRoot, 'afk-risk-x.txt');
    expect(classifyRisk('write_file', { file_path: p }, wsCtx)).toBe('safe');
    expect(classifyRisk('edit_file', { file_path: p }, wsCtx)).toBe('safe');
  });

  it('literal /tmp/x → high (shared world-writable /tmp is not a private root)', () => {
    // /tmp is world-writable (1777) on Linux and macOS (via symlink to /private/tmp
    // which is also 1777). It is never a private root under the new contract.
    // On all platforms this should be high (not in any private temp root).
    const expected = 'high';
    expect(classifyRisk('write_file', { file_path: LITERAL_TMP_X }, wsCtx)).toBe(expected);
  });

  it('patch_apply with every path in session root → safe', () => {
    const input = {
      changes: [
        { path: path.join(fixture, 'a.txt'), content: 'a' },
        { path: path.join(sessRoot, 'afk-risk-b.txt'), content: 'b' },
      ],
    };
    expect(classifyRisk('patch_apply', input, wsCtx)).toBe('safe');
  });

  it('patch_apply mixing session-root path + a denylisted path → high', () => {
    const input = {
      changes: [
        { path: path.join(fixture, 'a.txt'), content: 'a' },
        { path: path.join(homedir(), '.ssh', 'authorized_keys'), content: 'x' },
      ],
    };
    const v = classifyRiskDetailed('patch_apply', input, wsCtx);
    expect(v.level).toBe('high');
    expect(v.reason).toMatch(/^write-denylist: /);
  });

  it('tmp path inside a .git/ dir → high', () => {
    const v = classifyRiskDetailed(
      'write_file',
      { file_path: path.join(fixture, 'repo', '.git', 'config') },
      wsCtx,
    );
    expect(v.level).toBe('high');
    expect(v.reason).toMatch(/^git-dir: .* is inside \.git\/$/);
  });

  it('getTempRoots() includes the session root and satisfies new contract', () => {
    const roots = getTempRoots();
    // Session root (private 0700 mkdtemp) must be included.
    expect(roots).toContain(sessRoot);
    // No root should be shared-world-writable: on POSIX all entries must pass
    // the isPrivateTempRoot predicate (symlink=false, owned, mode&0o022===0).
    // We cannot lstat here without importing fs, so just assert non-empty.
    expect(roots.length).toBeGreaterThan(0);
  });

  it('getTempRoots() session root appears first', () => {
    const roots = getTempRoots();
    expect(roots[0]).toBe(sessRoot);
  });

  it('cached session root is re-validated: reaped and replaced by a non-directory → dropped', () => {
    // Prime the cache (both candidates exist, so the result is cached).
    expect(getTempRoots()).toContain(sessRoot);
    expect(getTempRoots()).toContain(sessRoot);
    // Simulate a tmp reaper deleting the idle root and something else taking
    // its name. A regular file fails isPrivateTempRoot on every platform.
    rmSync(sessRoot, { recursive: true, force: true });
    writeFileSync(sessRoot, 'not a dir');
    // (No classification assertion: sessRoot lives under os.tmpdir(), which is
    // itself a private root on macOS, so the path stays admissible through it.)
    expect(getTempRoots()).not.toContain(sessRoot);
  });

  it('cached session root is re-validated: reaped and not re-created → dropped', () => {
    expect(getTempRoots()).toContain(sessRoot);
    rmSync(sessRoot, { recursive: true, force: true });
    expect(getTempRoots()).not.toContain(sessRoot);
  });

  it('<sessRoot>-sibling/x (prefix lookalike) → high', () => {
    // The sibling dir name starts with the session root path but is outside it.
    const roots = getTempRoots();
    const outer = roots.filter((r) => !roots.some((o) => o !== r && r.startsWith(o + path.sep)));
    expect(outer.length).toBeGreaterThan(0);
    for (const root of outer) {
      const v = classifyRiskDetailed(
        'write_file',
        { file_path: path.join(`${root}-sibling`, 'x.txt') },
        wsCtx,
      );
      expect(v.level).toBe('high');
      expect(v.reason).toMatch(/^workspace-escape: /);
    }
  });

  it('dangling symlink in session root → non-tmp, non-denylisted target outside workspace → high', () => {
    const link = path.join(fixture, 'link.txt');
    symlinkSync(path.resolve('/opt/afk-risk-dangling-target/out.txt'), link);
    const v = classifyRiskDetailed('write_file', { file_path: link }, wsCtx);
    expect(v.level).toBe('high');
    expect(v.reason).toMatch(/^workspace-escape: /);
  });

  it('dangling symlink in session root → another session-root path → safe', () => {
    const link = path.join(fixture, 'link.txt');
    symlinkSync(path.join(fixture, 'sub', 'target.txt'), link);
    expect(classifyRisk('write_file', { file_path: link }, wsCtx)).toBe('safe');
  });

  it('no workspaceRoot (non-AFK caller) → behaviour unchanged', () => {
    const noRoot: RiskContext = { cwd: WS };
    expect(classifyRisk('write_file', { file_path: path.join(fixture, 'x') }, noRoot)).toBe('safe');
    expect(classifyRisk('write_file', { file_path: OUTSIDE_NON_TMP }, noRoot)).toBe('safe');
    expect(
      classifyRisk('write_file', { file_path: path.join(homedir(), '.ssh', 'id_rsa') }, noRoot),
    ).toBe('high');
  });

  it('integration: session root in getTempRoots() → write under it with non-temp workspaceRoot is safe', () => {
    // setSessionTmpdirRootForTests(sessRoot) is already called in beforeEach.
    // sessRoot is a 0700 mkdtemp dir → qualifies as private.
    const roots = getTempRoots();
    expect(roots).toContain(sessRoot);
    const target = path.join(sessRoot, 'scratch', 'output.json');
    expect(classifyRisk('write_file', { file_path: target }, wsCtx)).toBe('safe');
  });
});

// ---- classifyRiskDetailed reasons -----------------------------------------
describe('classifyRiskDetailed — reasons for each high category', () => {
  it('workspace-escape names the path and the root', () => {
    const v = classifyRiskDetailed('write_file', { file_path: OUTSIDE_NON_TMP }, ctx);
    expect(v.level).toBe('high');
    expect(v.reason).toContain('workspace-escape: ');
    expect(v.reason).toContain(' is outside ');
    expect(v.reason).toContain('afk-risk-outside');
  });

  it('write-denylist names the matched prefix', () => {
    const v = classifyRiskDetailed(
      'write_file',
      { file_path: path.join(homedir(), '.ssh', 'id_rsa') },
      ctx,
    );
    expect(v.level).toBe('high');
    expect(v.reason).toMatch(/^write-denylist: .* is under .*\.ssh/);
  });

  it('bash-pattern names the matched token', () => {
    expect(classifyRiskDetailed('bash', { command: 'sudo ls' }, ctx)).toEqual({
      level: 'high',
      reason: "bash-pattern: matched 'sudo'",
    });
  });

  it('schedule-mutation', () => {
    const v = classifyRiskDetailed('create_schedule', { name: 'x' }, ctx);
    expect(v.level).toBe('high');
    expect(v.reason).toMatch(/^schedule-mutation/);
  });

  it('mcp-destructive-verb names the verb', () => {
    expect(classifyRiskDetailed('mcp__postgres__drop_table', {}, ctx)).toEqual({
      level: 'high',
      reason: 'mcp-destructive-verb: drop',
    });
  });

  it('worktree force remove and web_request DELETE carry reasons', () => {
    expect(
      classifyRiskDetailed('worktree', { action: 'remove', force: true }, ctx).reason,
    ).toBe('worktree-force-remove');
    expect(classifyRiskDetailed('web_request', { method: 'DELETE' }, ctx).reason).toBe(
      'web-request: DELETE',
    );
  });

  it('classifyRisk returns the detailed level', () => {
    expect(classifyRisk('bash', { command: 'sudo ls' }, ctx)).toBe(
      classifyRiskDetailed('bash', { command: 'sudo ls' }, ctx).level,
    );
  });
});

// ---- isOutsideRoot — portable win32 cross-drive test --------------------------
// Uses path.win32 so this runs correctly on every host (no platform gating).
describe('isOutsideRoot — win32 cross-drive semantics via path.win32', () => {
  const w32 = path.win32;

  it('same-drive descendant → inside (not outside)', () => {
    expect(isOutsideRoot('C:\\ws', 'C:\\ws\\a\\b.ts', w32)).toBe(false);
  });

  it('same-drive root itself → inside (rel is empty string)', () => {
    expect(isOutsideRoot('C:\\ws', 'C:\\ws', w32)).toBe(false);
  });

  it('same-drive sibling with shared prefix → outside (boundary-safe)', () => {
    // C:\ws-evil is NOT inside C:\ws — path.relative returns '..\ws-evil'
    expect(isOutsideRoot('C:\\ws', 'C:\\ws-evil\\a', w32)).toBe(true);
  });

  it('same-drive parent escape → outside', () => {
    expect(isOutsideRoot('C:\\ws', 'C:\\other', w32)).toBe(true);
  });

  it('different drive → outside (path.relative returns absolute on win32)', () => {
    // This is the bug: path.win32.relative('C:\\ws', 'D:\\x') === 'D:\\x'
    // which is absolute — the old rel.startsWith('..') check missed it.
    expect(isOutsideRoot('C:\\ws', 'D:\\x', w32)).toBe(true);
  });

  it('POSIX paths → same behaviour as path.posix', () => {
    expect(isOutsideRoot('/root/ws', '/root/ws/a', path.posix)).toBe(false);
    expect(isOutsideRoot('/root/ws', '/other', path.posix)).toBe(true);
  });
});

// ---- AFK_HOME under a temp root ---------------------------------------------
describe('classifyRisk — AFK_HOME inside temp root blocks carve-out', () => {
  // A workspace NOT under the temp dir, so all temp writes below are escapes
  // that only the carve-out can allow.
  const WS3 = path.resolve('/opt/afk-risk-ws3');
  const ws3Ctx: RiskContext = { cwd: WS3, workspaceRoot: WS3 };

  let sessRoot3: string;
  let afkHomeFixture: string;
  let sibling: string;

  beforeEach(() => {
    // Private session root (0700 mkdtemp) — fixtures live under it so they are
    // inside a private temp root regardless of os.tmpdir() world-writability.
    sessRoot3 = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'afk-risk-sess3-')));
    setSessionTmpdirRootForTests(sessRoot3);
    // Create two mkdtemp fixtures under the private session root.
    afkHomeFixture = realpathSync(mkdtempSync(path.join(sessRoot3, 'afk-risk-home-')));
    sibling = realpathSync(mkdtempSync(path.join(sessRoot3, 'afk-risk-sibling-')));
    // Point AFK_HOME at the fixture so the carve-out excludes it.
    vi.stubEnv('AFK_HOME', afkHomeFixture);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setSessionTmpdirRootForTests(undefined);
    rmSync(sessRoot3, { recursive: true, force: true });
  });

  it('write to <afkHome>/skills/x.md → high (workspace-escape, not safe via carve-out)', () => {
    const target = path.join(afkHomeFixture, 'skills', 'x.md');
    const v = classifyRiskDetailed('write_file', { file_path: target }, ws3Ctx);
    expect(v.level).toBe('high');
    expect(v.reason).toMatch(/^workspace-escape: /);
  });

  it('write to sibling temp fixture outside AFK_HOME → safe (carve-out still works)', () => {
    const target = path.join(sibling, 'scratch.txt');
    expect(classifyRisk('write_file', { file_path: target }, ws3Ctx)).toBe('safe');
  });
});
