import { describe, expect, it } from 'vitest';
import { emptyScrapeMessage } from './scrape-diagnostics.js';

const url = 'https://example.com/empty';

describe('emptyScrapeMessage', () => {
  it('does not invent unavailable metadata for older scrape results', () => {
    const message = emptyScrapeMessage(url, {
      title: '', markdown: '', finalUrl: url, usedRender: false,
    });
    expect(message).toMatch(/^web_scrape extracted no readable content from/);
    expect(message).not.toContain('HTTP');
    expect(message).not.toContain('raw body');
    expect(message).not.toContain('headless render');
    expect(message).toContain('one retry with mode: "raw"');
  });

  it('reports only render metadata when plain fetch received no response', () => {
    const message = emptyScrapeMessage(url, {
      title: '', markdown: '', finalUrl: url, usedRender: true,
      diagnostics: { render: 'succeeded', renderHttpStatus: null, renderFinalUrl: url },
    });
    expect(message).toContain('headless render succeeded');
    expect(message).not.toContain('fetch HTTP');
    expect(message).not.toContain('render HTTP');
    expect(message).not.toContain('raw body');
  });
});
