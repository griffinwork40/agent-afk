import { defineDocs, defineConfig } from 'fumadocs-mdx/config';

export const docs = defineDocs({
  // Contract: search depends on each compiled MDX module exporting
  // `structuredData` so `createFromSource` can build the index at build time
  // (no runtime filesystem reads). Under fumadocs-mdx@15 + fumadocs-core@16 the
  // default MDX preset emits that export automatically, so the prior
  // `postprocess.valueToExport: ['structuredData']` workaround (needed for the
  // mdx@14 + core@15 pairing) is gone — re-exporting it now would define
  // `structuredData` twice and fail the Turbopack build.
  dir: 'content/docs',
});

export default defineConfig();
