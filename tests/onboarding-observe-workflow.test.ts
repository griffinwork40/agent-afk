import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8').replace(/\r\n/g, '\n');

describe('advisory onboarding observation workflow', () => {
  it('pins every action to a full SHA with a version comment', () => {
    const workflow = read('.github/workflows/onboarding-observe.yml');
    const actions = [...workflow.matchAll(/^\s+(?:- )?uses:\s*(.+)$/gm)];
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) expect(action[1]).toMatch(/^[\w/-]+@[a-f0-9]{40} # v\d[^\n]*$/);
  });

  it('uses no secrets and grants only contents read permission', () => {
    const workflow = read('.github/workflows/onboarding-observe.yml');
    expect(workflow).not.toMatch(/secrets\s*[.\[]/i);
    expect(workflow).toMatch(/^permissions:\n  contents: read\n/m);
    expect(workflow.match(/permissions:/g)).toHaveLength(1);
    expect(workflow).not.toMatch(/:\s*write\b|write-all|pull_request_target/);
  });

  it('stays independent of the required CI gate', () => {
    expect(read('.github/workflows/ci.yml')).not.toMatch(/onboarding-observe|scripts\/onboarding/);
  });

  it('covers both platforms and supported and unsupported Node majors', () => {
    const workflow = read('.github/workflows/onboarding-observe.yml');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('schedule:');
    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('scripts/onboarding/**');
    expect(workflow).toContain('node: [20, 22, 24, 26]');
    expect(workflow).toContain('os: [windows-2022, macos-15]');
    expect(workflow).toContain('if-no-files-found: error');
    expect(workflow).toContain('GITHUB_STEP_SUMMARY');
  });
});
