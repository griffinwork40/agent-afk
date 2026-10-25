import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkDocsLinks, readDocsTree, type DocsTree } from '../scripts/check-docs-links.js';
import { internalTarget, links, parseRedirects, resolves, slug } from '../scripts/lib/docs-links.js';

function tree(extra: Partial<DocsTree> = {}): DocsTree {
  return {
    pages: { 'index.mdx': '[Guide](/guides/start#intro)', 'guides/start.mdx': '[Home](../index.mdx)' },
    metas: { 'meta.json': { pages: ['---Intro---', 'index', 'guides'] }, 'guides/meta.json': { pages: ['start'] } },
    redirects: [], ...extra,
  };
}

describe('documentation links and navigation', () => {
  it('passes absolute, relative, folder index, anchors, query strings, and redirects', () => {
    const input = tree();
    input.pages['guides/index.mdx'] = '<Card href="/old?from=home#x" />';
    input.metas['guides/meta.json'] = { pages: ['index', 'start'] };
    input.redirects = [{ source: '/old', destination: '/guides/start' }];
    expect(checkDocsLinks(input)).toEqual([]);
    expect(slug('/guides/index.mdx#heading')).toBe('/guides');
    expect(internalTarget('../guides/start.mdx#x', 'configuration/overview.mdx')).toBe('/guides/start');
    expect(internalTarget('https://example.com', 'index.mdx')).toBeUndefined();
    expect(internalTarget('#heading', 'index.mdx')).toBeUndefined();
  });

  it('detects broken Markdown, JSX, reference links, missing nav entries and orphan pages', () => {
    const input = tree({ pages: {
      'index.mdx': '[Bad](/missing)\n<Card href={"/also-missing"} />\n[Reference][ref]\n[ref]: /reference-missing',
      'orphan.mdx': '',
    } });
    const errors = checkDocsLinks(input);
    expect(errors).toContain('index.mdx: broken link /missing');
    expect(errors).toContain('index.mdx: broken link /also-missing');
    expect(errors).toContain('index.mdx: broken link /reference-missing');
    expect(errors).toContain('guides/meta.json: unresolved pages entry start');
    expect(errors).toContain('orphan.mdx: orphan page (not listed in reachable meta.json)');
  });

  it('ignores separators, includes ... pages, validates folder metadata reachability', () => {
    const input = tree();
    input.metas['meta.json'] = { pages: ['---Title---', '...'] };
    expect(checkDocsLinks(input)).toEqual([]);
    input.metas['meta.json'] = { pages: ['index'] };
    expect(checkDocsLinks(input)).toContain('guides/meta.json: unreachable navigation folder');
    expect(checkDocsLinks(input)).toContain('guides/start.mdx: orphan page (not listed in reachable meta.json)');
    input.metas['guides/meta.json'] = { pages: ['missing-even-if-unreachable'] };
    expect(checkDocsLinks(input)).toContain('guides/meta.json: unresolved pages entry missing-even-if-unreachable');
    input.metas['meta.json'] = { pages: ['index', 'missing-folder'] };
    expect(checkDocsLinks(input)).toContain('meta.json: unresolved pages entry missing-folder');
  });

  it('does not let broken or cyclic redirects count as valid links', () => {
    const pages = new Set(['/guides/start']);
    const redirects = [{ source: '/old', destination: '/missing' }, { source: '/a', destination: '/b' }, { source: '/b', destination: '/a' }];
    expect(resolves('/old', pages, redirects)).toBe(false);
    expect(resolves('/a', pages, redirects)).toBe(false);
    expect(resolves('/docs/guides/start', pages, [{ source: '/docs/:path*', destination: '/:path*' }])).toBe(true);
    expect(resolves('/docs/missing', pages, [{ source: '/docs/:path*', destination: '/:path*' }])).toBe(false);
    expect(checkDocsLinks(tree({ redirects }))).toContain('next.config.ts: redirect /old has missing destination /missing');
  });

  it('uses the first matching redirect even when a later redirect resolves', () => {
    expect(resolves('/old', new Set(['/ok']), [
      { source: '/old', destination: '/missing' },
      { source: '/old', destination: '/ok' },
    ])).toBe(false);
  });

  it('applies redirects before page lookup, including shadowed pages and cycles', () => {
    const pages = new Set(['/old', '/ok']);
    expect(resolves('/old', pages, [{ source: '/old', destination: '/missing' }])).toBe(false);
    expect(resolves('/old', pages, [{ source: '/old', destination: '/old' }])).toBe(false);
    expect(resolves('/old', pages, [{ source: '/old', destination: '/ok' }])).toBe(true);
  });

  it('extracts JSX and balanced Markdown destinations, skips code and comments', () => {
    expect(links(`
[Text](/a(b)) [Angle](</space%20page> "title")
<Card href='/card' /><Card href={"/jsx"} />
\`[not a link](/inline)\`
\`\`\`md
[not a link](/fenced)
\`\`\`
{/* <Card href="/comment" /> */}
<!-- [comment](/comment) -->
[Short] [Collapsed][]
[Short]: /short
[Collapsed]: /collapsed
`)).toEqual(['/a(b)', '/space%20page', '/short', '/collapsed', '/card', '/jsx']);
    expect(checkDocsLinks(tree({ pages: { 'index.mdx': '<Card href={variable} />' }, metas: { 'meta.json': { pages: ['index'] } } }))).toContain('index.mdx: nonliteral href {variable}');
  });

  it('parses redirect literals without importing the Next/Fumadocs config', () => {
    expect(parseRedirects(`export default { async redirects() { return [
      { source: '/old', destination: '/new', permanent: true },
      { source: variable, destination: '/no' },
    ] } }`)).toEqual([{ source: '/old', destination: '/new' }]);
  });

  it('reads filesystem fixtures, diagnoses malformed metadata, and produces stable errors', () => {
    const temp = mkdtempSync(join(tmpdir(), 'afk-doc-links-'));
    try {
      mkdirSync(join(temp, 'guides'));
      writeFileSync(join(temp, 'index.mdx'), '[missing](/missing)');
      writeFileSync(join(temp, 'meta.json'), '{"pages":["index","guides"]}');
      writeFileSync(join(temp, 'guides/meta.json'), '{invalid json');
      const input = readDocsTree(temp, '');
      const errors = checkDocsLinks(input);
      expect(errors).toContain('guides/meta.json: invalid metadata');
      expect(errors).toContain('index.mdx: broken link /missing');
      expect(errors).toEqual(checkDocsLinks(input));
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});
