import { defineDocs, defineConfig } from 'fumadocs-mdx/config';

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    // Invariant: search depends on each compiled MDX module exporting
    // `structuredData`. remarkStructure (the default MDX preset) populates
    // `vfile.data.structuredData`, but with the installed fumadocs-mdx@14 +
    // fumadocs-core@15 pairing the export step does not emit it automatically
    // (core 15's remarkStructure ignores the `exportAs` hint fumadocs-mdx
    // passes). Listing it in `postprocess.valueToExport` re-exports that vfile
    // data as a real module export, so `page.data.structuredData` is defined at
    // build time (no runtime filesystem reads) and `createFromSource` can build
    // the search index. Drop this once the two packages are realigned.
    postprocess: {
      valueToExport: ['structuredData'],
    },
  },
});

export default defineConfig();
