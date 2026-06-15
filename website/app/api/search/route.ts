import { createFromSource } from 'fumadocs-core/search/server';
import { source } from '@/lib/source';

// Contract: Fumadocs' RootProvider enables the search dialog by default
// (search.enabled defaults to true), and the default dialog issues
// GET /api/search?query=... via fumadocs-core's fetch client. Without this
// route handler that request 404s and the dialog silently returns no results
// ("search does nothing"). createFromSource builds an in-memory Orama index
// from the same loader the pages use (@/lib/source), keeping the index in sync
// with the rendered docs. This is the canonical server-search wiring; it relies
// on a Node runtime (the site already uses next.config redirects()/headers(),
// which are incompatible with output: 'export').
export const { GET } = createFromSource(source);
