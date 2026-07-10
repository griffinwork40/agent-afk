/**
 * Tests for the observe-only safe-destruct detector (Wave 1, gate-migration).
 *
 * Three contracts:
 *   1. `detectDestructiveCommands` matches the curated catastrophic patterns
 *      and — critically for calibration — does NOT flag common-but-safe near
 *      misses (`rm -r build/`, `rm -f lock`, `git branch -d`, `truncate -s 0`).
 *   2. The hook returns an `approve` catch-record (never a block) only on a
 *      `bash` PreToolUse with a destructive command; `{}` otherwise.
 *   3. It is wired into the default registry and, dispatched end-to-end, passes
 *      the command through (no throw) while recording `decision: 'approve'`.
 */

import { describe, it, expect } from 'vitest';
import type { HookContext, HookDecision, PreToolUseContext } from './hooks.js';
import {
  createSafeDestructDetect,
  detectDestructiveCommands,
  SAFE_DESTRUCT_DETECT_REASON_PREFIX,
} from './safe-destruct-detect.js';
import { createDefaultHookRegistry } from './default-hook-registry.js';

function preCtx(command: string, toolName = 'bash'): HookContext {
  const ctx: PreToolUseContext = { event: 'PreToolUse', toolName, input: { command } };
  return ctx;
}

describe('detectDestructiveCommands', () => {
  it.each([
    ['rm -rf /tmp/foo', 'rm-recursive-force'],
    ['rm -fr build', 'rm-recursive-force'],
    ['sudo rm -Rf /var/x', 'rm-recursive-force'],
    ['rm -rfv ~/.cache', 'rm-recursive-force'],
    ['rm -r -f dir', 'rm-recursive-force-split'],
    ['rm -f -r dir', 'rm-recursive-force-split'],
    ['rm --recursive --force dir', 'rm-recursive-force-long'],
    ['rm -rf --no-preserve-root /', 'rm-no-preserve-root'],
    ['git reset --hard HEAD~3', 'git-reset-hard'],
    ['git clean -fd', 'git-clean-force'],
    ['git push --force origin main', 'git-push-force'],
    ['git push -f', 'git-push-force'],
    ['git branch -D feature', 'git-branch-force-delete'],
    ['dd if=/x.img of=/dev/sda bs=1M', 'dd-to-device'],
    ['mkfs.ext4 /dev/sdb1', 'mkfs'],
    ['echo boot > /dev/sda', 'redirect-to-block-device'],
    ["find . -name '*.log' -delete", 'find-delete'],
    ['find . -exec rm {} +', 'find-delete'],
    ['shred -u secret.key', 'shred'],
    ["psql -c 'DROP DATABASE prod'", 'sql-drop-truncate-delete'],
    ["mysql -e 'TRUNCATE TABLE users'", 'sql-drop-truncate-delete'],
    ["psql -c 'DELETE FROM orders'", 'sql-drop-truncate-delete'],
    ['docker system prune -af', 'docker-destructive'],
    ['docker rm -f web', 'docker-destructive'],
    ['kubectl delete pod api-0', 'kubectl-delete'],
    ['terraform destroy -auto-approve', 'terraform-destroy'],
  ])('flags %j → %s', (command, expectedId) => {
    expect(detectDestructiveCommands(command)).toContain(expectedId);
  });

  it.each([
    ['rm file.txt'], // no recursive/force
    ['rm -r build'], // recursive only — deliberately NOT flagged
    ['rm -f stale.lock'], // force only
    ['git status'],
    ['git commit -m "wip"'],
    ['git push origin main'], // no force
    ['git branch -d merged'], // lowercase -d is the safe delete
    ['ls -la /var'],
    ['npm install'],
    ['dd if=/dev/zero of=/tmp/file bs=1M count=1'], // writes a file, not a device
    ['dd if=/dev/urandom of=/dev/null'], // pseudo-device excluded
    ['cat /dev/null > app.log'], // redirect to a file, not a device
    ['truncate -s 0 app.log'], // shell truncate, not SQL TRUNCATE TABLE
    ['echo "safe"'],
    [''],
  ])('does not flag benign %j', (command) => {
    expect(detectDestructiveCommands(command)).toEqual([]);
  });

  it('reports every distinct pattern in a compound command', () => {
    const ids = detectDestructiveCommands('rm -rf x && git push --force');
    expect(ids).toContain('rm-recursive-force');
    expect(ids).toContain('git-push-force');
  });
});

describe('createSafeDestructDetect (observe-only hook)', () => {
  const hook = createSafeDestructDetect();

  it('returns an approve catch-record with the stable reason prefix on a destructive bash command', () => {
    const decision = hook(preCtx('rm -rf /tmp/x'));
    expect(decision.decision).toBe('approve');
    expect(decision.reason).toContain(SAFE_DESTRUCT_DETECT_REASON_PREFIX);
    expect(decision.reason).toContain('rm-recursive-force');
  });

  it('NEVER blocks — no block decision, no continue:false (the interpreter-eval lesson)', () => {
    const decision: HookDecision = hook(preCtx('rm -rf / --no-preserve-root'));
    expect(decision.decision).not.toBe('block');
    expect(decision.continue).not.toBe(false);
  });

  it('passes through benign bash commands', () => {
    expect(hook(preCtx('rm -r build'))).toEqual({});
    expect(hook(preCtx('git status'))).toEqual({});
  });

  it('ignores non-bash tools', () => {
    expect(hook(preCtx('rm -rf /tmp/x', 'read_file'))).toEqual({});
  });

  it('ignores non-PreToolUse events', () => {
    const stop: HookContext = { event: 'Stop', sessionId: 's1' };
    expect(hook(stop)).toEqual({});
  });

  it('passes through when the command is absent or empty', () => {
    const noInput: HookContext = { event: 'PreToolUse', toolName: 'bash' };
    expect(hook(noInput)).toEqual({});
    expect(hook(preCtx(''))).toEqual({});
  });
});

describe('safe-destruct-detect wiring in the default registry', () => {
  it('is registered and records approve (without blocking) for a destructive bash call', async () => {
    const { registry } = createDefaultHookRegistry(undefined, 'cli');
    const ctx: PreToolUseContext = {
      event: 'PreToolUse',
      toolName: 'bash',
      input: { command: 'rm -rf /tmp/scratch' },
    };
    // Must not throw (a block would throw HookBlockedError through dispatch).
    const decision = await registry.dispatch(ctx);
    expect(decision.decision).toBe('approve');
    expect(decision.reason).toContain(SAFE_DESTRUCT_DETECT_REASON_PREFIX);
  });

  it('leaves benign bash calls untouched through the default registry', async () => {
    const { registry } = createDefaultHookRegistry(undefined, 'cli');
    const ctx: PreToolUseContext = {
      event: 'PreToolUse',
      toolName: 'bash',
      input: { command: 'git status' },
    };
    const decision = await registry.dispatch(ctx);
    expect(decision.decision).not.toBe('approve');
    expect(decision.decision).not.toBe('block');
  });
});
