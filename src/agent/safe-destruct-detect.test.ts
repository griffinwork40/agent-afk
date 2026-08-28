/**
 * Tests for the two-tier safe-destruct detector.
 *
 * Five contracts:
 *   1. `detectDestructiveCommands` matches every curated pattern and does NOT
 *      flag common-but-safe near-misses.
 *   2. OBSERVE patterns return `decision: 'approve'` (never block).
 *   3. BLOCK patterns return `decision: 'block'` with a reason that names the
 *      pattern id and an `injectContext` guidance string.
 *   4. When a single compound command matches both tiers, BLOCK wins.
 *   5. Registry wiring: the hook is registered exactly once, produces approve
 *      for OBSERVE patterns, and throws HookBlockedError (with injectContext)
 *      for BLOCK patterns.
 *
 * Note on the former 'NEVER blocks' test (~line 97-101 in the old file):
 *   It used `rm -rf / --no-preserve-root` as the fixture — that pattern moved
 *   to the BLOCK tier. The test has been split into two: one asserting OBSERVE
 *   patterns still approve, one asserting BLOCK patterns now block.
 */

import { describe, it, expect } from 'vitest';
import type { HookContext, HookDecision, PreToolUseContext } from './hooks.js';
import {
  createSafeDestructDetect,
  detectDestructiveCommands,
  SAFE_DESTRUCT_DETECT_REASON_PREFIX,
  SAFE_DESTRUCT_BLOCK_INJECT_CONTEXT,
} from './safe-destruct-detect.js';
import { HookBlockedError } from '../utils/errors.js';
import { createDefaultHookRegistry } from './default-hook-registry.js';

function preCtx(command: string, toolName = 'bash'): HookContext {
  const ctx: PreToolUseContext = { event: 'PreToolUse', toolName, input: { command } };
  return ctx;
}

// ---------------------------------------------------------------------------
// detectDestructiveCommands — pattern matching
// ---------------------------------------------------------------------------

describe('detectDestructiveCommands', () => {
  // ── OBSERVE patterns ───────────────────────────────────────────────────────
  it.each([
    ['rm -rf /tmp/foo', 'rm-recursive-force'],
    ['rm -fr build', 'rm-recursive-force'],
    ['sudo rm -Rf /var/x', 'rm-recursive-force'],
    ['rm -rfv ~/.cache', 'rm-recursive-force'],
    ['rm -r -f dir', 'rm-recursive-force-split'],
    ['rm -f -r dir', 'rm-recursive-force-split'],
    ['rm --recursive --force dir', 'rm-recursive-force-long'],
    ['git branch -D feature', 'git-branch-force-delete'],
    ["find . -name '*.log' -delete", 'find-delete'],
    ['find . -exec rm {} +', 'find-delete'],
    ['docker system prune -af', 'docker-destructive'],
    ['docker rm -f web', 'docker-destructive'],
    ['kubectl delete pod api-0', 'kubectl-delete'],
    ["psql -c 'DELETE FROM orders'", 'sql-delete-from'],
    // outbound HTTP writes (#1280)
    ['curl -X POST https://api.example.com/users', 'curl-write-method'],
    ['curl -X PUT https://api.example.com/users/1', 'curl-write-method'],
    ['curl -X PATCH https://api.example.com/users/1 -d \'{}\'', 'curl-write-method'],
    ['curl -X DELETE https://api.example.com/users/1', 'curl-write-method'],
    ['curl -d \'{"k":"v"}\' https://api.example.com/hook', 'curl-data-flag'],
    ['curl --data @body.json https://api.example.com/events', 'curl-data-flag'],
    ['curl -F file=@photo.png https://api.example.com/upload', 'curl-data-flag'],
    ['wget --post-data="msg=hi" https://api.example.com/notify', 'curl-data-flag'],
    // no-space -XPOST form (#1302 review)
    ['curl -XPOST https://api.example.com/users', 'curl-write-method'],
    ['curl -XDELETE https://api.example.com/users/1', 'curl-write-method'],
    // --request long form (#1302 review)
    ['curl --request POST https://api.example.com/users', 'curl-write-method'],
    ['curl --request DELETE https://api.example.com/users/1', 'curl-write-method'],
    // wget --post-file (#1302 review)
    ['wget --post-file=body.bin https://api.example.com/upload', 'curl-data-flag'],
  ])('OBSERVE: flags %j → %s', (command, expectedId) => {
    expect(detectDestructiveCommands(command)).toContain(expectedId);
  });

  // ── BLOCK patterns ─────────────────────────────────────────────────────────
  it.each([
    ['rm -rf --no-preserve-root /', 'rm-no-preserve-root'],
    ['git reset --hard HEAD~3', 'git-reset-hard'],
    ['git clean -fd', 'git-clean-force'],
    ['git clean --force -x', 'git-clean-force'],
    ['git push --force origin main', 'git-push-force'],
    ['git push -f', 'git-push-force'],
    ['git -C /tmp/repo reset --hard HEAD', 'git-reset-hard'],
    ['git --work-tree=/tmp/w reset --hard', 'git-reset-hard'],
    ['git -C /other push --force origin main', 'git-push-force'],
    ['git --git-dir=.git clean -fd', 'git-clean-force'],
    ['dd if=/x.img of=/dev/sda bs=1M', 'dd-to-device'],
    ['mkfs.ext4 /dev/sdb1', 'mkfs'],
    ['echo boot > /dev/sda', 'redirect-to-block-device'],
    ['shred -u secret.key', 'shred'],
    ["psql -c 'DROP DATABASE prod'", 'sql-drop-truncate'],
    ["mysql -e 'TRUNCATE TABLE users'", 'sql-drop-truncate'],
    ["psql -c 'DROP TABLE foo'", 'sql-drop-truncate'],
    ["psql -c 'DROP SCHEMA public'", 'sql-drop-truncate'],
    ["psql -c 'DROP INDEX idx_name'", 'sql-drop-truncate'],
    ['terraform destroy -auto-approve', 'terraform-destroy'],
    // service-registration patterns (#1311 review)
    ['launchctl load /Library/LaunchDaemons/com.example.plist', 'launchctl-service-register'],
    ['launchctl bootstrap gui/501 /path/to/com.example.plist', 'launchctl-service-register'],
    ['launchctl submit -l com.example.service -- /usr/local/bin/mybin', 'launchctl-service-register'],
    ['launchctl start com.example.service', 'launchctl-service-register'],
    ['launchctl kickstart -k gui/501/com.example.service', 'launchctl-service-register'],
    ['launchctl enable system/com.example.service', 'launchctl-service-register'],
    ['systemctl enable afk-telegram.service', 'systemctl-service-enable'],
    ['systemctl --user enable --now afk-telegram.service', 'systemctl-service-enable'],
    ['systemctl --type=service enable afk-telegram.service', 'systemctl-service-enable'],
    ['systemctl daemon-reload', 'systemctl-service-enable'],
  ])('BLOCK: flags %j → %s', (command, expectedId) => {
    expect(detectDestructiveCommands(command)).toContain(expectedId);
  });

  // ── enable-linger false-positive fix (#1311 Item 3) ──────────────────────
  it('systemctl enable-linger root → does NOT match systemctl-service-enable', () => {
    const ids = detectDestructiveCommands('systemctl enable-linger root');
    expect(ids).not.toContain('systemctl-service-enable');
  });

  // ── benign commands — must match nothing ────────────────────────────────────
  it.each([
    ['rm file.txt'], // no recursive/force
    ['rm -r build'], // recursive only — deliberately NOT flagged
    ['rm -f stale.lock'], // force only
    ['git status'],
    ['git commit -m "wip"'],
    ['git push origin main'], // no force
    ['git push --force-with-lease origin main'], // safe lease variant
    ['git push --force-with-lease=origin/main origin main'], // =<refname> form
    ['git branch -d merged'], // lowercase -d is the safe delete
    ['ls -la /var'],
    ['npm install'],
    ['dd if=/dev/zero of=/tmp/file bs=1M count=1'], // writes a file, not a device
    ['dd if=/dev/urandom of=/dev/null'], // pseudo-device excluded
    ['cat /dev/null > app.log'], // redirect to a file, not a device
    ['truncate -s 0 app.log'], // shell truncate, not SQL TRUNCATE TABLE
    ['echo "safe"'],
    ['curl https://api.example.com/health'], // plain GET — not a write
    ['curl -s https://api.example.com/status'], // silent GET
    ['curl -X GET https://api.example.com/items'], // explicit GET is not a write
    [''],
  ])('does not flag benign %j', (command) => {
    expect(detectDestructiveCommands(command)).toEqual([]);
  });

  it('reports every distinct pattern in a compound command', () => {
    const ids = detectDestructiveCommands('rm -rf x && git push --force');
    expect(ids).toContain('rm-recursive-force');
    expect(ids).toContain('git-push-force');
  });

  it('sql-drop-truncate-delete id no longer exists; split ids are sql-drop-truncate and sql-delete-from', () => {
    // Verify the split: old monolithic id is gone; both new ids fire correctly.
    const drop = detectDestructiveCommands("DROP TABLE users");
    expect(drop).toContain('sql-drop-truncate');
    expect(drop).not.toContain('sql-drop-truncate-delete');

    const del = detectDestructiveCommands('DELETE FROM orders WHERE id=1');
    expect(del).toContain('sql-delete-from');
    expect(del).not.toContain('sql-drop-truncate-delete');
  });
});

// ---------------------------------------------------------------------------
// createSafeDestructDetect — hook decisions
// ---------------------------------------------------------------------------

describe('createSafeDestructDetect (two-tier hook)', () => {
  const hook = createSafeDestructDetect();

  // ── OBSERVE patterns must approve ─────────────────────────────────────────
  it.each([
    ['rm -rf /tmp/x', 'rm-recursive-force'],
    ['rm -r -f /tmp/x', 'rm-recursive-force-split'],
    ['rm --recursive --force /tmp/x', 'rm-recursive-force-long'],
    ['git branch -D stale', 'git-branch-force-delete'],
    ["find . -name '*.tmp' -delete", 'find-delete'],
    ['docker system prune -af', 'docker-destructive'],
    ['kubectl delete pod api-0', 'kubectl-delete'],
    ['DELETE FROM sessions WHERE expired=1', 'sql-delete-from'],
    // outbound HTTP writes (#1280) — OBSERVE, never block
    ['curl -X POST https://api.example.com/', 'curl-write-method'],
    ['curl -XPOST https://api.example.com/', 'curl-write-method'],
    ['curl --request POST https://api.example.com/', 'curl-write-method'],
    ['curl -d \'{"k":"v"}\' https://api.example.com/events', 'curl-data-flag'],
    ['wget --post-data="x=1" https://api.example.com/hook', 'curl-data-flag'],
    ['wget --post-file=body.bin https://api.example.com/upload', 'curl-data-flag'],
  ])('OBSERVE pattern %s returns approve, not block', (command, _id) => {
    const decision: HookDecision = hook(preCtx(command));
    expect(decision.decision).toBe('approve');
    expect(decision.decision).not.toBe('block');
    expect(decision.reason).toContain(SAFE_DESTRUCT_DETECT_REASON_PREFIX);
  });

  // ── BLOCK patterns must block and name the pattern id ────────────────────
  it.each([
    ['rm -rf --no-preserve-root /', 'rm-no-preserve-root'],
    ['git reset --hard HEAD', 'git-reset-hard'],
    ['git clean -fd .', 'git-clean-force'],
    ['git push --force origin main', 'git-push-force'],
    ['dd if=/dev/zero of=/dev/sda', 'dd-to-device'],
    ['mkfs.ext4 /dev/sdb1', 'mkfs'],
    ['echo x > /dev/sda', 'redirect-to-block-device'],
    ['shred -u key.pem', 'shred'],
    ["psql -c 'DROP DATABASE prod'", 'sql-drop-truncate'],
    ["mysql -e 'TRUNCATE TABLE users'", 'sql-drop-truncate'],
    ['terraform destroy -auto-approve', 'terraform-destroy'],
  ])('BLOCK pattern %s returns block decision naming %s with injectContext', (command, expectedPatternId) => {
    const decision: HookDecision = hook(preCtx(command));
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain(expectedPatternId);
    expect(decision.injectContext).toBe(SAFE_DESTRUCT_BLOCK_INJECT_CONTEXT);
  });

  // ── BLOCK wins when both tiers match in one compound command ─────────────
  it('block wins over approve when a compound command matches both tiers', () => {
    // rm -rf → OBSERVE; git push --force → BLOCK
    const decision: HookDecision = hook(preCtx('rm -rf build && git push --force origin main'));
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('git-push-force');
    expect(decision.injectContext).toBe(SAFE_DESTRUCT_BLOCK_INJECT_CONTEXT);
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

// ---------------------------------------------------------------------------
// Registry wiring
// ---------------------------------------------------------------------------

describe('safe-destruct-detect wiring in the default registry', () => {
  it('is registered and records approve (without blocking) for an OBSERVE-tier destructive bash call', async () => {
    const { registry } = createDefaultHookRegistry(undefined, 'cli');
    const ctx: PreToolUseContext = {
      event: 'PreToolUse',
      toolName: 'bash',
      input: { command: 'rm -rf /tmp/scratch' },
    };
    // Must not throw — OBSERVE tier passes through.
    const decision = await registry.dispatch(ctx);
    expect(decision.decision).toBe('approve');
    expect(decision.reason).toContain(SAFE_DESTRUCT_DETECT_REASON_PREFIX);
  });

  it('throws HookBlockedError with injectContext for a BLOCK-tier destructive bash call through the default registry', async () => {
    const { registry } = createDefaultHookRegistry(undefined, 'cli');
    const ctx: PreToolUseContext = {
      event: 'PreToolUse',
      toolName: 'bash',
      input: { command: 'terraform destroy -auto-approve' },
    };
    // BLOCK tier must throw HookBlockedError with injectContext.
    try {
      await registry.dispatch(ctx);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HookBlockedError);
      expect((err as HookBlockedError).injectContext).toBe(SAFE_DESTRUCT_BLOCK_INJECT_CONTEXT);
    }
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
