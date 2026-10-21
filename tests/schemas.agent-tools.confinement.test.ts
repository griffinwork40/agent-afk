/**
 * Pins the readRoots/writeRoots confinement descriptions in agentTool schema.
 *
 * These descriptions are the authoritative runtime contract for how extra read/write
 * roots interact with session confinement. A silent edit would change what the model
 * sees when deciding whether to grant access — CI must catch any drift.
 *
 * #3772 from advisory findings 2026-10-14 PR triage batch.
 */
import { describe, expect, it } from 'vitest';

import { agentTool, composeTool } from '../src/agent/tools/schemas.agent-tools.js';

function propDesc(propName: string): string {
  const schema = agentTool.input_schema as {
    properties: Record<string, { description?: string }>;
  };
  const desc = schema.properties[propName]?.description;
  if (!desc) throw new Error(`agentTool has no input_schema property "${propName}"`);
  return desc;
}

describe('agentTool readRoots/writeRoots confinement descriptions', () => {
  it('writeRoots description pins confinement semantics', () => {
    const desc = propDesc('writeRoots');
    // Confined-session default: writes only inside cwd/worktree + OS temp
    expect(desc).toContain('confined sessions');
    expect(desc).toContain('cwd/worktree');
    expect(desc).toContain('auto-denied');
    // Unconfined pass-through is documented
    expect(desc).toContain('unconfined access');
    expect(desc).toContain('no effect and do not request confinement');
    // Mutual exclusion with worktree isolation
    expect(desc).toContain('Mutually exclusive with isolation:"worktree"');
  });

  it('readRoots description pins confinement semantics', () => {
    const desc = propDesc('readRoots');
    // Confined-session scope: composed with inherited read scope
    expect(desc).toContain('confined sessions');
    expect(desc).toContain("fork's inherited read scope");
    expect(desc).toContain('no effect and do not request confinement');
    // Grandchildren are not granted by default
    expect(desc).toContain('Grandchildren must be re-granted');
    // Unlike writeRoots, compatible with worktree isolation
    expect(desc).toContain('NOT mutually exclusive with isolation:"worktree"');
  });
});

/**
 * Pins the per-node readRoots/writeRoots descriptions in composeTool schema.
 *
 * The compose tool's per-node confinement descriptions can drift silently from
 * the agentTool equivalents. CI must catch any drift. (#4203, #3794)
 */
function composeNodePropDesc(propName: string): string {
  const schema = composeTool.input_schema as unknown as {
    properties: {
      nodes: {
        items: {
          properties: Record<string, { description?: string }>;
        };
      };
    };
  };
  const desc = schema.properties.nodes.items.properties[propName]?.description;
  if (!desc) throw new Error(`composeTool node has no property "${propName}"`);
  return desc;
}

describe('composeTool per-node readRoots/writeRoots confinement descriptions', () => {
  it('writeRoots description pins confinement semantics', () => {
    const desc = composeNodePropDesc('writeRoots');
    expect(desc).toContain('confined sessions');
    expect(desc).toContain('child cwd');
    expect(desc).toContain('no effect and do not request confinement');
  });

  it('readRoots description pins confinement semantics', () => {
    const desc = composeNodePropDesc('readRoots');
    expect(desc).toContain('confined sessions');
    expect(desc).toContain('Grandchildren must be re-granted');
    expect(desc).toContain('no effect and do not request confinement');
  });
});
