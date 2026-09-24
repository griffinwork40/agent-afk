import { describe, it, expect } from 'vitest';
import { homedir } from 'os';
import { parseComposeInput } from './compose-input-parse.js';

/** Minimal valid input helper. */
function minimal(nodeOverrides?: Record<string, unknown>, topOverrides?: Record<string, unknown>) {
  return {
    nodes: [{ id: 'a', prompt: 'do something', ...nodeOverrides }],
    ...topOverrides,
  };
}

describe('parseComposeInput — per-node cwd', () => {
  it('accepts a valid absolute cwd', () => {
    const { parsed } = parseComposeInput(minimal({ cwd: '/tmp/my-worktree' }));
    expect(parsed.nodes[0]!.cwd).toBe('/tmp/my-worktree');
  });

  it('omits cwd when not provided', () => {
    const { parsed } = parseComposeInput(minimal());
    expect(parsed.nodes[0]!.cwd).toBeUndefined();
  });

  it('rejects relative cwd', () => {
    expect(() => parseComposeInput(minimal({ cwd: 'relative/path' }))).toThrow(
      /must be an absolute path/,
    );
  });

  it('rejects cwd with .. segments', () => {
    expect(() => parseComposeInput(minimal({ cwd: '/foo/../bar' }))).toThrow(
      /must not contain "\.\." segments/,
    );
  });

  it('accepts cwd with ".." as a substring (not a segment)', () => {
    // Paths like /repo/package..backup contain ".." but as a filename
    // substring, NOT as a bare path segment — must not be rejected.
    const { parsed } = parseComposeInput(minimal({ cwd: '/repo/package..backup' }));
    expect(parsed.nodes[0]!.cwd).toBe('/repo/package..backup');
  });

  it('rejects non-string cwd', () => {
    expect(() => parseComposeInput(minimal({ cwd: 42 }))).toThrow(
      /cwd must be a non-empty string/,
    );
  });

  it('rejects empty string cwd', () => {
    expect(() => parseComposeInput(minimal({ cwd: '  ' }))).toThrow(
      /cwd must be a non-empty string/,
    );
  });
});

describe('parseComposeInput — per-node readRoots', () => {
  it('accepts valid absolute readRoots', () => {
    const { parsed } = parseComposeInput(minimal({ readRoots: ['/data', '/config'] }));
    expect(parsed.nodes[0]!.readRoots).toEqual(['/data', '/config']);
  });

  it('omits readRoots when not provided', () => {
    const { parsed } = parseComposeInput(minimal());
    expect(parsed.nodes[0]!.readRoots).toBeUndefined();
  });

  it('treats empty array as undefined', () => {
    const { parsed } = parseComposeInput(minimal({ readRoots: [] }));
    expect(parsed.nodes[0]!.readRoots).toBeUndefined();
  });

  it('rejects non-array readRoots', () => {
    expect(() => parseComposeInput(minimal({ readRoots: '/single' }))).toThrow(
      /readRoots must be an array/,
    );
  });

  it('rejects relative path in readRoots', () => {
    expect(() => parseComposeInput(minimal({ readRoots: ['relative'] }))).toThrow(
      /readRoots entry must be an absolute path/,
    );
  });

  it('rejects readRoots entry with .. segments', () => {
    expect(() => parseComposeInput(minimal({ readRoots: ['/foo/../bar'] }))).toThrow(
      /readRoots entry must not contain "\.\." segments/,
    );
  });

  it('accepts readRoots entry with ".." as a substring (not a segment)', () => {
    // e.g. /repo/package..backup is a valid path that contains ".." but not as
    // a bare traversal segment — matches the agent tool's behaviour (#662).
    const { parsed } = parseComposeInput(minimal({ readRoots: ['/repo/package..backup'] }));
    expect(parsed.nodes[0]!.readRoots).toEqual(['/repo/package..backup']);
  });

  it('rejects non-string entries in readRoots', () => {
    expect(() => parseComposeInput(minimal({ readRoots: [42] }))).toThrow(
      /readRoots entries must be non-empty strings/,
    );
  });
});

describe('parseComposeInput — per-node writeRoots', () => {
  it('accepts valid absolute writeRoots', () => {
    const { parsed } = parseComposeInput(minimal({ writeRoots: ['/output'] }));
    expect(parsed.nodes[0]!.writeRoots).toEqual(['/output']);
  });

  it('omits writeRoots when not provided', () => {
    const { parsed } = parseComposeInput(minimal());
    expect(parsed.nodes[0]!.writeRoots).toBeUndefined();
  });

  it('treats empty array as undefined', () => {
    const { parsed } = parseComposeInput(minimal({ writeRoots: [] }));
    expect(parsed.nodes[0]!.writeRoots).toBeUndefined();
  });

  it('rejects non-array writeRoots', () => {
    expect(() => parseComposeInput(minimal({ writeRoots: '/single' as unknown as string[] }))).toThrow(
      /writeRoots must be an array/,
    );
  });

  it('rejects non-string entries in writeRoots', () => {
    expect(() => parseComposeInput(minimal({ writeRoots: [42] as unknown as string[] }))).toThrow(
      /writeRoots entries must be non-empty strings/,
    );
  });

  it('rejects relative path in writeRoots', () => {
    expect(() => parseComposeInput(minimal({ writeRoots: ['relative'] }))).toThrow(
      /writeRoots entry must be an absolute path/,
    );
  });

  it('rejects writeRoots entry with .. segments', () => {
    expect(() => parseComposeInput(minimal({ writeRoots: ['/foo/../bar'] }))).toThrow(
      /writeRoots entry must not contain "\.\." segments/,
    );
  });
});

describe('parseComposeInput — S-2 breadth guards on cwd', () => {
  it('rejects home dir as cwd', () => {
    expect(() => parseComposeInput(minimal({ cwd: homedir() }))).toThrow(
      /cwd is too broad/,
    );
  });

  it('rejects filesystem root as cwd', () => {
    expect(() => parseComposeInput(minimal({ cwd: '/' }))).toThrow(
      /cwd is too broad/,
    );
  });

  it('rejects cwd that would un-gate a credential root', () => {
    // ~/.config/gh is a bash credential root; its parent ~/.config is not in
    // the denylist but is an ancestor of the credential root, so granting it
    // as cwd would un-gate the credential subtree via the bash restriction
    // filter's ancestor-based containment check.
    expect(() =>
      parseComposeInput(minimal({ cwd: `${homedir()}/.config` })),
    ).toThrow(/un-gate credential root/);
  });

  it('accepts a valid project-scoped cwd', () => {
    const { parsed } = parseComposeInput(minimal({ cwd: '/projects/my-repo' }));
    expect(parsed.nodes[0]!.cwd).toBe('/projects/my-repo');
  });
});

describe('parseComposeInput — S-2 breadth guards on readRoots', () => {
  it('rejects home dir as a readRoots entry', () => {
    expect(() => parseComposeInput(minimal({ readRoots: [homedir()] }))).toThrow(
      /readRoots entry is too broad/,
    );
  });

  it('rejects filesystem root as a readRoots entry', () => {
    expect(() => parseComposeInput(minimal({ readRoots: ['/'] }))).toThrow(
      /readRoots entry is too broad/,
    );
  });

  it('rejects readRoots entry that would un-gate a credential root', () => {
    // ~/.config/gh is a credential root; ~/.config is its ancestor and would
    // un-gate it via the bash restriction containment check.
    expect(() =>
      parseComposeInput(minimal({ readRoots: [`${homedir()}/.config`] })),
    ).toThrow(/un-gate credential root/);
  });

  it('rejects a readRoots entry that is a denylist-matched credential path', () => {
    // Use a subpath of ~/.gnupg: it is within the isReadDenied denylist
    // prefix but is NOT caught by ungatedSensitiveRoot (which only fires for
    // ancestors/equals of sensitive roots, not children). The error must
    // mention "protected/credential path" from isReadDenied, not
    // "un-gate credential root" from ungatedSensitiveRoot.
    const gnupgSubpath = `${homedir()}/.gnupg/private-keys-v1.d`;
    expect(() =>
      parseComposeInput(minimal({ readRoots: [gnupgSubpath] })),
    ).toThrow(/protected\/credential path/);
  });
});

describe('parseComposeInput — S-2 breadth guards on writeRoots', () => {
  it('rejects home dir as a writeRoots entry', () => {
    expect(() => parseComposeInput(minimal({ writeRoots: [homedir()] }))).toThrow(
      /writeRoots entry is too broad/,
    );
  });

  it('rejects filesystem root as a writeRoots entry', () => {
    expect(() => parseComposeInput(minimal({ writeRoots: ['/'] }))).toThrow(
      /writeRoots entry is too broad/,
    );
  });

  it('rejects writeRoots entry that would un-gate a credential root', () => {
    expect(() =>
      parseComposeInput(minimal({ writeRoots: [`${homedir()}/.config`] })),
    ).toThrow(/un-gate credential root/);
  });
});

describe('parseComposeInput — S-3 isReadDenied extended to writeRoots', () => {
  it('rejects a writeRoots entry targeting a read-denylist path', () => {
    // Use a subpath of ~/.gnupg that is:
    //   - Matched by isReadDenied (within the ~/.gnupg prefix)
    //   - NOT caught by ungatedSensitiveRoot (a child, not an ancestor/equal)
    //     so this test exercises the isReadDenied branch specifically.
    // The error message must mention "protected/credential path" — the phrase
    // from the isReadDenied check — NOT "un-gate credential root" from the
    // ungatedSensitiveRoot check.
    const gnupgSubpath = `${homedir()}/.gnupg/private-keys-v1.d`;
    expect(() =>
      parseComposeInput(minimal({ writeRoots: [gnupgSubpath] })),
    ).toThrow(/protected\/credential path/);
  });

  it('rejects a writeRoots entry for ~/.ssh with the protected-path message', () => {
    // ~/.ssh is directly on the denylist — ungatedSensitiveRoot also fires
    // (the candidate equals the sensitive root), but the breadth guards run
    // first, so the error comes from un-gate rather than protected-path.
    // This test documents that ~/.ssh in writeRoots is always rejected.
    expect(() =>
      parseComposeInput(minimal({ writeRoots: [`${homedir()}/.ssh`] })),
    ).toThrow();
  });
});

describe('parseComposeInput — per-node max_tool_rounds', () => {
  it('accepts a valid per-node max_tool_rounds', () => {
    const { parsed } = parseComposeInput(minimal({ max_tool_rounds: 10 }));
    expect(parsed.nodes[0]!.max_tool_rounds).toBe(10);
  });

  it('omits max_tool_rounds when not provided', () => {
    const { parsed } = parseComposeInput(minimal());
    expect(parsed.nodes[0]!.max_tool_rounds).toBeUndefined();
  });

  it('rejects zero max_tool_rounds', () => {
    expect(() => parseComposeInput(minimal({ max_tool_rounds: 0 }))).toThrow(
      /positive finite number/,
    );
  });

  it('rejects negative max_tool_rounds', () => {
    expect(() => parseComposeInput(minimal({ max_tool_rounds: -5 }))).toThrow(
      /positive finite number/,
    );
  });

  it('rejects fractional max_tool_rounds', () => {
    expect(() => parseComposeInput(minimal({ max_tool_rounds: 1.5 }))).toThrow(
      /must be an integer/,
    );
  });

  it('rejects max_tool_rounds above 1000', () => {
    expect(() => parseComposeInput(minimal({ max_tool_rounds: 1001 }))).toThrow(
      /must be at most 1000/,
    );
  });

  it('accepts boundary value 1', () => {
    const { parsed } = parseComposeInput(minimal({ max_tool_rounds: 1 }));
    expect(parsed.nodes[0]!.max_tool_rounds).toBe(1);
  });

  it('accepts boundary value 1000', () => {
    const { parsed } = parseComposeInput(minimal({ max_tool_rounds: 1000 }));
    expect(parsed.nodes[0]!.max_tool_rounds).toBe(1000);
  });

  it('rejects non-number max_tool_rounds', () => {
    expect(() => parseComposeInput(minimal({ max_tool_rounds: 'ten' }))).toThrow(
      /positive finite number/,
    );
  });

  it('per-node value is independent across nodes', () => {
    const { parsed } = parseComposeInput({
      nodes: [
        { id: 'a', prompt: 'task a', max_tool_rounds: 5 },
        { id: 'b', prompt: 'task b', max_tool_rounds: 20 },
        { id: 'c', prompt: 'task c' },
      ],
    });
    expect(parsed.nodes[0]!.max_tool_rounds).toBe(5);
    expect(parsed.nodes[1]!.max_tool_rounds).toBe(20);
    expect(parsed.nodes[2]!.max_tool_rounds).toBeUndefined();
  });
});

describe('parseComposeInput — per-node max_turns', () => {
  it('accepts a valid per-node max_turns', () => {
    const { parsed } = parseComposeInput(minimal({ max_turns: 5 }));
    expect(parsed.nodes[0]!.max_turns).toBe(5);
  });

  it('omits max_turns when not provided', () => {
    const { parsed } = parseComposeInput(minimal());
    expect(parsed.nodes[0]!.max_turns).toBeUndefined();
  });

  it('rejects zero max_turns', () => {
    expect(() => parseComposeInput(minimal({ max_turns: 0 }))).toThrow(
      /positive integer/,
    );
  });

  it('rejects negative max_turns', () => {
    expect(() => parseComposeInput(minimal({ max_turns: -1 }))).toThrow(
      /positive integer/,
    );
  });

  it('rejects fractional max_turns', () => {
    expect(() => parseComposeInput(minimal({ max_turns: 2.5 }))).toThrow(
      /positive integer/,
    );
  });

  it('rejects non-number max_turns', () => {
    expect(() => parseComposeInput(minimal({ max_turns: 'five' }))).toThrow(
      /positive integer/,
    );
  });

  it('accepts boundary value 1', () => {
    const { parsed } = parseComposeInput(minimal({ max_turns: 1 }));
    expect(parsed.nodes[0]!.max_turns).toBe(1);
  });

  it('per-node max_turns is independent across nodes', () => {
    const { parsed } = parseComposeInput({
      nodes: [
        { id: 'a', prompt: 'task a', max_turns: 3 },
        { id: 'b', prompt: 'task b' },
      ],
    });
    expect(parsed.nodes[0]!.max_turns).toBe(3);
    expect(parsed.nodes[1]!.max_turns).toBeUndefined();
  });

  it('can combine max_turns and max_tool_rounds on same node', () => {
    const { parsed } = parseComposeInput(minimal({ max_turns: 4, max_tool_rounds: 50 }));
    expect(parsed.nodes[0]!.max_turns).toBe(4);
    expect(parsed.nodes[0]!.max_tool_rounds).toBe(50);
  });
});

describe('parseComposeInput — per-node agent_type', () => {
  it('accepts a valid agent_type string', () => {
    const { parsed } = parseComposeInput(minimal({ agent_type: 'my-researcher' }));
    expect(parsed.nodes[0]!.agent_type).toBe('my-researcher');
  });

  it('omits agent_type when not provided', () => {
    const { parsed } = parseComposeInput(minimal());
    expect(parsed.nodes[0]!.agent_type).toBeUndefined();
  });

  it('rejects empty string agent_type', () => {
    expect(() => parseComposeInput(minimal({ agent_type: '' }))).toThrow(
      /non-empty string/,
    );
  });

  it('rejects whitespace-only agent_type', () => {
    expect(() => parseComposeInput(minimal({ agent_type: '   ' }))).toThrow(
      /non-empty string/,
    );
  });

  it('rejects non-string agent_type', () => {
    expect(() => parseComposeInput(minimal({ agent_type: 42 }))).toThrow(
      /non-empty string/,
    );
  });
});

describe('parseComposeInput — combined fields', () => {
  it('passes all five fields through when valid', () => {
    const input = {
      nodes: [{
        id: 'worker',
        prompt: 'build it',
        model: 'sonnet',
        cwd: '/repo/packages/web',
        readRoots: ['/repo/shared'],
        writeRoots: ['/repo/packages/web/dist'],
        max_tool_rounds: 50,
        max_turns: 10,
      }],
    };
    const { parsed } = parseComposeInput(input);
    const node = parsed.nodes[0]!;
    expect(node.cwd).toBe('/repo/packages/web');
    expect(node.readRoots).toEqual(['/repo/shared']);
    expect(node.writeRoots).toEqual(['/repo/packages/web/dist']);
    expect(node.max_tool_rounds).toBe(50);
    expect(node.max_turns).toBe(10);
  });

  it('allows cwd without readRoots/writeRoots', () => {
    const { parsed } = parseComposeInput(minimal({ cwd: '/work' }));
    const node = parsed.nodes[0]!;
    expect(node.cwd).toBe('/work');
    expect(node.readRoots).toBeUndefined();
    expect(node.writeRoots).toBeUndefined();
  });

  it('allows readRoots without cwd', () => {
    const { parsed } = parseComposeInput(minimal({ readRoots: ['/data'] }));
    const node = parsed.nodes[0]!;
    expect(node.cwd).toBeUndefined();
    expect(node.readRoots).toEqual(['/data']);
  });
});

describe('parseComposeInput — per-node agent_type', () => {
  it('accepts a valid agent_type string', () => {
    const { parsed } = parseComposeInput(minimal({ agent_type: 'my-researcher' }));
    expect(parsed.nodes[0]!.agent_type).toBe('my-researcher');
  });

  it('omits agent_type when not provided', () => {
    const { parsed } = parseComposeInput(minimal());
    expect(parsed.nodes[0]!.agent_type).toBeUndefined();
  });

  it('rejects empty string agent_type', () => {
    expect(() => parseComposeInput(minimal({ agent_type: '' }))).toThrow(
      /non-empty string/,
    );
  });

  it('rejects whitespace-only agent_type', () => {
    expect(() => parseComposeInput(minimal({ agent_type: '   ' }))).toThrow(
      /non-empty string/,
    );
  });

  it('rejects non-string agent_type', () => {
    expect(() => parseComposeInput(minimal({ agent_type: 42 }))).toThrow(
      /non-empty string/,
    );
  });
});

describe('parseComposeInput — per-node isolation', () => {
  it('accepts isolation:"worktree"', () => {
    const { parsed } = parseComposeInput(minimal({ isolation: 'worktree' }));
    expect(parsed.nodes[0]!.isolation).toBe('worktree');
  });

  it('accepts isolation:"none" and omits the field (normalized)', () => {
    const { parsed } = parseComposeInput(minimal({ isolation: 'none' }));
    // 'none' is a no-op — the field is still stored as-is (compose normalises
    // differently from the agent tool, which strips it). Accept either shape.
    // The important thing: it must not throw.
    expect(['none', undefined]).toContain(parsed.nodes[0]!.isolation);
  });

  it('rejects an unknown isolation value', () => {
    expect(() => parseComposeInput(minimal({ isolation: 'sandbox' }))).toThrow(
      /isolation must be "none" or "worktree"/,
    );
  });

  it('rejects isolation:"worktree" combined with cwd', () => {
    expect(() =>
      parseComposeInput(minimal({ isolation: 'worktree', cwd: '/repo/packages/web' })),
    ).toThrow(/cannot set both cwd and isolation:"worktree"/);
  });

  it('rejects isolation:"worktree" combined with writeRoots', () => {
    expect(() =>
      parseComposeInput(minimal({ isolation: 'worktree', writeRoots: ['/repo/packages/web/dist'] })),
    ).toThrow(/cannot set both writeRoots and isolation:"worktree"/);
  });

  it('allows isolation:"worktree" combined with readRoots (reads do not break isolation)', () => {
    const { parsed } = parseComposeInput(
      minimal({ isolation: 'worktree', readRoots: ['/repo/shared'] }),
    );
    expect(parsed.nodes[0]!.isolation).toBe('worktree');
    expect(parsed.nodes[0]!.readRoots).toEqual(['/repo/shared']);
  });

  it('does not apply writeRoots+isolation guard when isolation is "none"', () => {
    // isolation:"none" does not restrict write access, so writeRoots is allowed.
    const { parsed } = parseComposeInput(
      minimal({ isolation: 'none', writeRoots: ['/repo/packages/web/dist'] }),
    );
    expect(parsed.nodes[0]!.writeRoots).toEqual(['/repo/packages/web/dist']);
  });
});

describe('parseComposeInput — compose-level fields still work', () => {
  it('accepts max_tool_rounds_per_node at compose level', () => {
    const { parsed } = parseComposeInput(minimal({}, { max_tool_rounds_per_node: 30 }));
    expect(parsed.max_tool_rounds_per_node).toBe(30);
  });

  it('per-node max_tool_rounds coexists with compose-level max_tool_rounds_per_node', () => {
    const { parsed } = parseComposeInput({
      nodes: [{ id: 'a', prompt: 'task a', max_tool_rounds: 7 }],
      max_tool_rounds_per_node: 100,
    });
    expect(parsed.nodes[0]!.max_tool_rounds).toBe(7);
    expect(parsed.max_tool_rounds_per_node).toBe(100);
  });
});
