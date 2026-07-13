/**
 * Tests for the observe-only release-boundary detector (Wave 1 slice 2,
 * gate-migration).
 *
 * Three contracts:
 *   1. `detectReleaseBoundaryCommands` matches the curated publish/deploy/sync
 *      boundary patterns and — critically for calibration — does NOT flag
 *      common pre-boundary near misses (`npm version`, `git tag`, a plain
 *      `git push origin main`, `npm install`).
 *   2. The hook returns an `approve` catch-record (never a block) only on a
 *      `bash` PreToolUse with a boundary-crossing command; `{}` otherwise.
 *   3. It is wired into the default registry and, dispatched end-to-end, passes
 *      the command through (no throw) while recording `decision: 'approve'`.
 */

import { describe, it, expect } from 'vitest';
import type { HookContext, HookDecision, PreToolUseContext } from './hooks.js';
import {
  createReleaseBoundaryDetect,
  detectReleaseBoundaryCommands,
  RELEASE_BOUNDARY_DETECT_REASON_PREFIX,
} from './release-boundary-detect.js';
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

describe('createReleaseBoundaryDetect (observe-only hook)', () => {
  const hook = createReleaseBoundaryDetect();

  it('returns an approve catch-record with the stable reason prefix on a boundary bash command', () => {
    const decision = hook(preCtx('npm publish --provenance'));
    expect(decision.decision).toBe('approve');
    expect(decision.reason).toContain(RELEASE_BOUNDARY_DETECT_REASON_PREFIX);
    expect(decision.reason).toContain('npm-publish');
  });

  it('NEVER blocks — no block decision, no continue:false (the interpreter-eval lesson)', () => {
    const decision: HookDecision = hook(preCtx('git push --mirror git@github.com:org/x.git'));
    expect(decision.decision).not.toBe('block');
    expect(decision.continue).not.toBe(false);
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

describe('release-boundary-detect wiring in the default registry', () => {
  it('is registered and records approve (without blocking) for a boundary bash call', async () => {
    const { registry } = createDefaultHookRegistry(undefined, 'cli');
    const ctx: PreToolUseContext = {
      event: 'PreToolUse',
      toolName: 'bash',
      input: { command: 'npm publish --provenance' },
    };
    // Must not throw (a block would throw HookBlockedError through dispatch).
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
