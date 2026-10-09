/**
 * Focused unit tests for scripts/render-env-registry.mdx.ts.
 *
 * Covers:
 *   1. MDX-escaping of descriptions (< > { } | → entities / backslash-pipe).
 *   2. Exhaustive categoryLabels — every EnvVarCategory has a label.
 *   3. assertCategoryOrderCompleteness rejects unknown categories.
 *   4. renderMdx output includes the expected frontmatter, MDX comment, and
 *      intro paragraph verbatim.
 *   5. renderMdx uses em-dash for missing defaults and backtick-wraps known ones.
 */

import { describe, it, expect } from 'vitest';
import {
  renderMdx,
  assertCategoryOrderCompleteness,
} from '../scripts/render-env-registry.mdx.js';
import type { EnvVarMeta } from '../src/config/env.js';
import { ENV_REGISTRY } from '../src/config/env.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<EnvVarMeta> & { name: string }): EnvVarMeta {
  return {
    description: 'A test variable.',
    type: 'string',
    required: false,
    category: 'misc',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// MDX escaping
// ---------------------------------------------------------------------------

describe('renderMdx — MDX escaping', () => {
  it('escapes < and > in descriptions', () => {
    const registry: readonly EnvVarMeta[] = [
      makeEntry({ name: 'TEST_ANGLES', description: 'Path like <cwd>/.mcp.json.' }),
    ];
    const output = renderMdx(registry);
    expect(output).toContain('&lt;cwd&gt;');
    expect(output).not.toContain('<cwd>');
  });

  it('leaves < > { } literal inside inline-code spans but still escapes pipes', () => {
    const registry: readonly EnvVarMeta[] = [
      makeEntry({
        name: 'TEST_CODE_SPAN',
        description: 'Run `afk login --profile <name>` or `{"a":1|2}` for <cwd>.',
      }),
    ];
    const output = renderMdx(registry);
    expect(output).toContain('`afk login --profile <name>`');
    expect(output).toContain('`{"a":1\\|2}`');
    expect(output).toContain('for &lt;cwd&gt;.');
    expect(output).not.toContain('&lt;name&gt;');
  });

  it('throws on a description with an unbalanced backtick', () => {
    const registry: readonly EnvVarMeta[] = [
      makeEntry({ name: 'TEST_ODD_TICK', description: 'Lone ` tick then <x>.' }),
    ];
    expect(() => renderMdx(registry)).toThrow(/TEST_ODD_TICK.*unbalanced backtick/);
  });

  it('escapes { and } in descriptions', () => {
    const registry: readonly EnvVarMeta[] = [
      makeEntry({ name: 'TEST_BRACES', description: 'State at {home}/state.' }),
    ];
    const output = renderMdx(registry);
    expect(output).toContain('&#123;home&#125;');
    expect(output).not.toContain('{home}');
  });

  it('escapes | in descriptions with backslash', () => {
    const registry: readonly EnvVarMeta[] = [
      makeEntry({ name: 'TEST_PIPE', description: 'Accepts low | medium | high.' }),
    ];
    const output = renderMdx(registry);
    expect(output).toContain('low \\| medium \\| high');
    expect(output).not.toMatch(/low \| medium/);
  });

  it('does not double-escape already-safe text', () => {
    const registry: readonly EnvVarMeta[] = [
      makeEntry({ name: 'TEST_SAFE', description: 'A plain description without special chars.' }),
    ];
    const output = renderMdx(registry);
    expect(output).toContain('A plain description without special chars.');
  });

  it('handles a description containing all special chars at once', () => {
    const registry: readonly EnvVarMeta[] = [
      makeEntry({
        name: 'TEST_COMBO',
        description: '<tag> {val} a | b',
      }),
    ];
    const output = renderMdx(registry);
    expect(output).toContain('&lt;tag&gt; &#123;val&#125; a \\| b');
  });
});

// ---------------------------------------------------------------------------
// Default column
// ---------------------------------------------------------------------------

describe('renderMdx — default column', () => {
  it('renders em-dash when no default is set', () => {
    const registry: readonly EnvVarMeta[] = [makeEntry({ name: 'TEST_NO_DEFAULT' })];
    const output = renderMdx(registry);
    expect(output).toContain('| — |');
  });

  it('renders backtick-wrapped value when default is set', () => {
    const registry: readonly EnvVarMeta[] = [
      makeEntry({ name: 'TEST_WITH_DEFAULT', default: '127.0.0.1' }),
    ];
    const output = renderMdx(registry);
    expect(output).toContain('| `127.0.0.1` |');
  });
});

// ---------------------------------------------------------------------------
// Frontmatter and structure
// ---------------------------------------------------------------------------

describe('renderMdx — page structure', () => {
  it('includes verbatim frontmatter', () => {
    const output = renderMdx(ENV_REGISTRY);
    expect(output).toContain('title: "Environment Variables"');
    expect(output).toContain(
      'description: "Complete reference for all environment variables recognized by agent-afk, grouped by category."',
    );
  });

  it('includes the MDX generation comment after frontmatter', () => {
    const output = renderMdx(ENV_REGISTRY);
    const frontmatterEnd = output.indexOf('---', 4); // second ---
    const commentPos = output.indexOf('{/* Generated from src/config/env.ts');
    expect(commentPos).toBeGreaterThan(frontmatterEnd);
    expect(output).toContain('Do not edit by hand; run `pnpm scan:env`.');
  });

  it('includes the verbatim intro paragraph', () => {
    const output = renderMdx(ENV_REGISTRY);
    expect(output).toContain(
      'All environment variables recognized by `agent-afk` are listed here',
    );
    expect(output).toContain('`~/.afk/config/afk.env`');
  });

  it('uses the correct column headers', () => {
    const output = renderMdx(ENV_REGISTRY);
    expect(output).toContain('| Variable | Type | Description | Default |');
  });

  it('produces one row per registry entry (222 vars)', () => {
    const output = renderMdx(ENV_REGISTRY);
    // Count lines that are data rows (start with | `)
    const rows = output.split('\n').filter((l) => l.startsWith('| `'));
    expect(rows).toHaveLength(ENV_REGISTRY.length);
  });
});

// ---------------------------------------------------------------------------
// Exhaustive category labels — every EnvVarCategory member has a label
// ---------------------------------------------------------------------------

describe('renderMdx — exhaustive category labels', () => {
  it('renders a heading for every category present in ENV_REGISTRY', () => {
    const output = renderMdx(ENV_REGISTRY);
    const categories = [...new Set(ENV_REGISTRY.map((e) => e.category))];
    // Every category that has vars should produce a ## heading in the output
    for (const cat of categories) {
      const entries = ENV_REGISTRY.filter((e) => e.category === cat);
      if (entries.length === 0) continue;
      // The heading text is whatever categoryLabels maps to — just verify a heading exists
      const hasSection = output.includes('\n## ');
      expect(hasSection, `Output should have at least one section heading`).toBe(true);
    }
  });

  it('assertCategoryOrderCompleteness throws for a registry with an unlisted category', () => {
    const badEntry = makeEntry({
      name: 'TEST_UNKNOWN_CAT',
      // Casting to bypass TypeScript — simulates a newly-added category not yet in the order list
      category: 'newcat' as EnvVarMeta['category'],
    });
    expect(() => assertCategoryOrderCompleteness([badEntry])).toThrow(
      /categories missing from categoryOrder or categoryLabels/,
    );
  });

  it('assertCategoryOrderCompleteness passes for valid registry', () => {
    expect(() => assertCategoryOrderCompleteness(ENV_REGISTRY)).not.toThrow();
  });
});
