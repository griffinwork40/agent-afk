// Barrel — splits the original 599-LOC committed-band module into two sibling
// files to stay within the <350 LOC per-file budget. All public symbols are
// re-exported here so existing importers need no changes.
export * from './terminal-compositor.committed-band-commit.js';
export * from './terminal-compositor.committed-band-repin.js';
