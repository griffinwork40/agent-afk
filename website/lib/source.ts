import { docs } from 'collections/server';
import { loader } from 'fumadocs-core/source';

export const source = loader({
  // Docs are served at the root of the dedicated docs subdomain
  // (docs.agentafk.com), so page URLs are root-relative (/quickstart, not
  // /docs/quickstart). The route lives in the app/(docs) route group, which
  // is invisible in the URL.
  baseUrl: '/',
  source: docs.toFumadocsSource(),
});
