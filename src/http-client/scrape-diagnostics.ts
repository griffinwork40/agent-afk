import type { ScrapeResult } from './scrape.js';

/** Compact diagnostic for empty extraction; absent metadata is never guessed. */
export function emptyScrapeMessage(url: string, result: ScrapeResult): string {
  const details: string[] = [];
  const diagnostics = result.diagnostics;
  const response = diagnostics?.fetch;
  if (response !== undefined) {
    details.push(`fetch HTTP ${response.httpStatus}`);
    if (response.finalUrl !== url) details.push(`fetch final URL ${response.finalUrl}`);
    if (response.contentType) details.push(`content-type ${response.contentType}`);
    if (response.rawBodyBytes !== undefined) details.push(`raw body ${response.rawBodyBytes} UTF-8 bytes`);
  }
  if (diagnostics !== undefined) {
    details.push(`headless render ${diagnostics.render}`);
    if (diagnostics.renderHttpStatus != null) {
      details.push(`render HTTP ${diagnostics.renderHttpStatus}`);
    }
    if (diagnostics.renderFinalUrl && diagnostics.renderFinalUrl !== url) {
      details.push(`render final URL ${diagnostics.renderFinalUrl}`);
    }
  } else if (result.finalUrl && result.finalUrl !== url) {
    details.push(`final URL ${result.finalUrl}`);
  }
  const metadata = details.length > 0 ? ` (${details.join('; ')})` : '';
  return `web_scrape extracted no readable content from ${url}${metadata}. ` +
    'Try one retry with mode: "raw" to inspect the HTML; a short body during parallel requests ' +
    'to the same host often means throttling, so back off rather than re-request in parallel.';
}
