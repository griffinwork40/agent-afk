import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
// Match the existing workflow-contract tests' indentation-based parsing, without
// adding a YAML dependency. Job ids are scoped to jobs, not trigger mappings.
const jobs = workflow.split(/^jobs:\n/m)[1]!;
const blocks = new Map([...jobs.matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:|(?![\s\S]))/gm)]
  .map((match) => [match[1]!, match[2]!]));
const gate = blocks.get('ci-gate')!;

describe('aggregate CI gate', () => {
  it('requires every other job exactly once, including raw matrix jobs', () => {
    const needs = gate.match(/^    needs:\n((?:      - [\w-]+\n)+)/m)?.[1];
    expect(needs).toBeDefined();
    const ids = [...needs!.matchAll(/- ([\w-]+)/g)].map((match) => match[1]!);
    expect(ids.sort()).toEqual([...blocks.keys()].filter((id) => id !== 'ci-gate').sort());
    expect(blocks.size).toBeGreaterThan(1);
  });

  it('always runs a stable, non-optional check with no step-level skip', () => {
    expect(gate).toMatch(/^    name: CI Gate$/m);
    expect(gate).toMatch(/^    if: \$\{\{ always\(\) \}\}$/m);
    expect(gate).toContain('NEEDS_JSON: ${{ toJSON(needs) }}');
    expect(gate).not.toMatch(/^        if:|continue-on-error:/m);
    // No current job can legitimately skip. Adding conditional jobs requires
    // revisiting the skip policy, not silently accepting every skipped job.
    for (const [id, block] of blocks) {
      if (id !== 'ci-gate' && id !== 'test-windows') expect(block).not.toMatch(/^    if:/m);
    }
    expect(blocks.get('test-windows')).toMatch(/^    if: \$\{\{ always\(\) \}\}$/m);
  });

  it.each(['success', 'failure', 'cancelled', 'skipped', '', 'unexpected'])(
    'executes the actual inline gate for dependency result %j', (result) => {
      const outcomes = Object.fromEntries([...blocks.keys()].filter((id) => id !== 'ci-gate')
        .map((id) => [id, { result: id === 'test-windows-shards' ? result : 'success' }]));
      const execution = execute(outcomes);
      expect(execution.error).toBeUndefined();
      expect(execution.status).toBe(result === 'success' ? 0 : 1);
    },
  );

  it('fails closed with no dependency results', () => {
    expect(execute({}).status).toBe(1);
  });
});

function execute(outcomes: Record<string, { result: string }>) {
  const script = gate.match(/          node <<'NODE'\n([\s\S]*?)          NODE/)?.[1];
  expect(script).toBeDefined();
  // Run the exact JS from the workflow, on all platforms, without needing a
  // shell or jq in the test environment. GitHub's Ubuntu runner supplies node.
  return spawnSync(process.execPath, ['-e', script!], {
    encoding: 'utf8', env: { NEEDS_JSON: JSON.stringify(outcomes) },
  });
}
