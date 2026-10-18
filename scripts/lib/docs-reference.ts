import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeMdx } from '../render-env-registry.mdx.js';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Reuse the env renderer's code-span-aware escaping; flatten table newlines. */
export function cell(value: unknown): string {
  const text = String(value ?? '').replace(/\r?\n/g, ' ');
  // The env helper assumes paired inline code. Fail clearly instead of letting
  // malformed future metadata expose raw JSX or an MDX expression.
  if ((text.match(/`/g) ?? []).length % 2) throw new Error(`Unbalanced backtick in reference metadata: ${text}`);
  return escapeMdx(text);
}

/** Code spans may themselves contain backticks. Use an HTML code element then. */
export function code(value: string): string {
  if (value.includes('`')) {
    return `<code>${value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('{', '&#123;').replaceAll('}', '&#125;').replaceAll('|', '&#124;').replaceAll('`', '&#96;')}</code>`;
  }
  return `\`${value.replaceAll('|', '\\|').replace(/\r?\n/g, ' ')}\``;
}

export function pageHeader(title: string, description: string, scan: string, source: string): string[] {
  return ['---', `title: ${JSON.stringify(title)}`, `description: ${JSON.stringify(description)}`, '---', '',
    `{/* Generated from ${source}. Do not edit by hand; run \`pnpm ${scan}\`. */}`, ''];
}

/** Byte-exact comparison, matching render-env-registry.ts (no normalization). */
export function writeReference(slug: string, output: string, check: boolean, directory = resolve(repoRoot, 'website/content/docs/reference')): boolean {
  const path = resolve(directory, `${slug}.mdx`);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (check) {
    if (current !== output) {
      console.error(`Reference drift: ${slug}. Run pnpm scan:${slug === 'cli' ? 'cli' : slug === 'slash-commands' ? 'slash' : 'config'}.`);
      return false;
    }
    console.log(`Reference in sync: ${slug}`);
    return true;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, output);
  console.log(`Wrote reference/${slug}.mdx`);
  return true;
}

export function isMain(url: string): boolean {
  if (!process.argv[1]) return false;
  try { return fileURLToPath(url) === realpathSync(process.argv[1]); }
  catch { return false; }
}
