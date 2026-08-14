/**
 * Tests for the two-tier release-boundary detector (Wave 1 block+explain
 * upgrade, gate-migration).
 *
 * Six contracts:
 *   1. `detectReleaseBoundaryCommands` matches the curated publish/deploy/sync
 *      boundary patterns and — critically for calibration — does NOT flag
 *      common pre-boundary near misses (`npm version`, `git tag`, a plain
 *      `git push origin main`, `npm install`).
 *   2. OBSERVE patterns (sync-boundary) return `decision: 'approve'`.
 *   3. BLOCK patterns (publish/deploy/infra) return `decision: 'block'` with a
 *      reason naming the pattern and `injectContext` guidance.
 *   4. When a compound command matches both tiers, BLOCK wins.
 *   5. Non-boundary commands, non-bash tools, and non-PreToolUse events pass
 *      through as `{}`.
 *   6. Registry wiring: dispatched end-to-end, BLOCK-tier throws
 *      HookBlockedError with injectContext; OBSERVE-tier records approve.
 */

import { describe, it, expect } from 'vitest';
import type { HookContext, HookDecision, PreToolUseContext } from './hooks.js';
import {
  createReleaseBoundaryDetect,
  detectReleaseBoundaryCommands,
  RELEASE_BOUNDARY_DETECT_REASON_PREFIX,
  RELEASE_BOUNDARY_BLOCK_INJECT_CONTEXT,
} from './release-boundary-detect.js';
import { HookBlockedError } from '../utils/errors.js';
import { createDefaultHookRegistry } from './default-hook-registry.js';

function preCtx(command: string, toolName = 'bash'): HookContext {
  const ctx: PreToolUseContext = { event: 'PreToolUse', toolName, input: { command } };
  return ctx;
}

describe('detectReleaseBoundaryCommands', () => {
  it.each([
    ['npm publish --provenance', 'npm-publish'],
    ['pnpm publish --no-git-checks', 'pnpm-publish'],
    ['yarn publish', 'yarn-publish'],
    ['yarn npm publish', 'yarn-publish'],
    ['cargo publish', 'cargo-publish'],
    ['twine upload dist/*', 'pypi-twine-upload'],
    ['poetry publish --build', 'poetry-publish'],
    ['gem push mygem-1.0.0.gem', 'gem-push'],
    ['docker push registry.io/app:latest', 'docker-push'],
    ['docker image push registry.io/app:latest', 'docker-push'],
    ['gh release create v1.2.3 --generate-notes', 'gh-release-create'],
    ['terraform apply -auto-approve', 'terraform-apply'],
    ['kubectl apply -f deploy.yaml', 'kubectl-apply'],
    ['git push --mirror git@github.com:org/mirror.git', 'git-push-mirror'],
    ['git push origin main --follow-tags', 'git-push-tags'],
    ['git push origin --tags', 'git-push-tags'],
  ])('flags %j → %s', (command, expectedId) => {
    expect(detectReleaseBoundaryCommands(command)).toContain(expectedId);
  });

  it.each([
    ['npm version patch'], // bumps + tags locally — not the publish boundary
    ['npm install'],
    ['npm run build'],
    ['git tag v1.2.3'], // creating a tag is local; pushing it is the boundary
    ['git push origin main'], // no --mirror / --tags
    ['git commit -m "release prep"'],
    ['cargo build --release'], // "release" the profile, not a publish
    ['docker build -t app .'], // build, not push
    ['gh release view v1.0.0'], // read, not create
    ['terraform plan'], // plan, not apply
    ['kubectl get pods'],
    [''],
  ])('does not flag pre-boundary/benign %j', (command) => {
    expect(detectReleaseBoundaryCommands(command)).toEqual([]);
  });

  it('reports every distinct pattern in a compound command', () => {
    const ids = detectReleaseBoundaryCommands('npm publish && git push origin --tags');
    expect(ids).toContain('npm-publish');
    expect(ids).toContain('git-push-tags');
  });
});

// ---------------------------------------------------------------------------
// createReleaseBoundaryDetect — two-tier hook decisions
// ---------------------------------------------------------------------------

describe('createReleaseBoundaryDetect (two-tier hook)', () => {
  const hook = createReleaseBoundaryDetect();

  // ── BLOCK patterns (publish/deploy/infra) must block with injectContext ────
  it.each([
    ['npm publish --provenance', 'npm-publish'],
    ['pnpm publish --no-git-checks', 'pnpm-publish'],
    ['yarn publish', 'yarn-publish'],
    ['cargo publish', 'cargo-publish'],
    ['twine upload dist/*', 'pypi-twine-upload'],
    ['poetry publish --build', 'poetry-publish'],
    ['gem push mygem-1.0.0.gem', 'gem-push'],
    ['docker push registry.io/app:latest', 'docker-push'],
    ['gh release create v1.2.3 --generate-notes', 'gh-release-create'],
    ['terraform apply -auto-approve', 'terraform-apply'],
    ['kubectl apply -f deploy.yaml', 'kubectl-apply'],
  ])('BLOCK pattern %s returns block decision naming %s with injectContext', (command, expectedPatternId) => {
    const decision: HookDecision = hook(preCtx(command));
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain(expectedPatternId);
    expect(decision.injectContext).toBe(RELEASE_BOUNDARY_BLOCK_INJECT_CONTEXT);
  });

  // ── OBSERVE patterns (sync-boundary) must approve ─────────────────────────
  it.each([
    ['git push --mirror git@github.com:org/x.git', 'git-push-mirror'],
    ['git push origin --tags', 'git-push-tags'],
    ['git push origin main --follow-tags', 'git-push-tags'],
  ])('OBSERVE pattern %s returns approve, not block', (command, _id) => {
    const decision: HookDecision = hook(preCtx(command));
    expect(decision.decision).toBe('approve');
    expect(decision.decision).not.toBe('block');
    expect(decision.reason).toContain(RELEASE_BOUNDARY_DETECT_REASON_PREFIX);
  });

  // ── BLOCK wins when both tiers match in one compound command ───────────────
  it('block wins over approve when a compound command matches both tiers', () => {
    // npm publish → BLOCK; git push --tags → OBSERVE
    const decision: HookDecision = hook(preCtx('npm publish && git push origin --tags'));
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('npm-publish');
    expect(decision.injectContext).toBe(RELEASE_BOUNDARY_BLOCK_INJECT_CONTEXT);
  });

  it('passes through non-boundary bash commands', () => {
    expect(hook(preCtx('git push origin main'))).toEqual({});
    expect(hook(preCtx('npm install'))).toEqual({});
  });

  it('ignores non-bash tools', () => {
    expect(hook(preCtx('npm publish', 'read_file'))).toEqual({});
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

describe('release-boundary-detect wiring in the default registry', () => {
  it('throws HookBlockedError with injectContext for a BLOCK-tier boundary bash call', async () => {
    const { registry } = createDefaultHookRegistry(undefined, 'cli');
    const ctx: PreToolUseContext = {
      event: 'PreToolUse',
      toolName: 'bash',
      input: { command: 'npm publish --provenance' },
    };
    try {
      await registry.dispatch(ctx);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HookBlockedError);
      expect((err as HookBlockedError).injectContext).toBe(RELEASE_BOUNDARY_BLOCK_INJECT_CONTEXT);
    }
  });

  it('records approve (without blocking) for an OBSERVE-tier sync-boundary call', async () => {
    const { registry } = createDefaultHookRegistry(undefined, 'cli');
    const ctx: PreToolUseContext = {
      event: 'PreToolUse',
      toolName: 'bash',
      input: { command: 'git push origin --tags' },
    };
    // Must not throw — OBSERVE tier passes through.
    const decision = await registry.dispatch(ctx);
    expect(decision.decision).toBe('approve');
    expect(decision.reason).toContain(RELEASE_BOUNDARY_DETECT_REASON_PREFIX);
  });

  it('leaves non-boundary bash calls untouched through the default registry', async () => {
    const { registry } = createDefaultHookRegistry(undefined, 'cli');
    const ctx: PreToolUseContext = {
      event: 'PreToolUse',
      toolName: 'bash',
      input: { command: 'git push origin main' },
    };
    const decision = await registry.dispatch(ctx);
    expect(decision.decision).not.toBe('approve');
    expect(decision.decision).not.toBe('block');
  });
});
