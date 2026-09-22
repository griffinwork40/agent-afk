import path from 'node:path';
import type { NextConfig } from 'next';
import { createMDX } from 'fumadocs-mdx/next';

const nextConfig: NextConfig = {
  trailingSlash: false,
  // Invariant: pin the file-tracing root to the MONOREPO ROOT (the parent of
  // this `website/` dir), not the project dir. Vercel deploys this site with
  // Root Directory = website; under Next 16 the post-build platform finalizer
  // locates the app's `.next` by joining <repoRoot> + <relativeAppDir>. When
  // the tracing root is set to the project dir, Next records relativeAppDir = ""
  // and the finalizer looks for `<repoRoot>/.next/package.json` (the repo root,
  // not website/), failing the deploy with ENOENT after a successful build.
  // Setting the tracing root one level up makes relativeAppDir = "website" so
  // the finalizer resolves `<repoRoot>/website/.next` correctly. This is also
  // the documented monorepo value (Next infers the same via the parent lockfile,
  // but pinning it is deterministic).
  outputFileTracingRoot: path.resolve(__dirname, '..'),
  images: {
    remotePatterns: [],
  },
  async redirects() {
    // Docs are served at the root of the dedicated docs subdomain
    // (docs.agentafk.com). Redirect any legacy /docs/* links to the root
    // equivalent so older references don't 404.
    return [
      { source: '/docs', destination: '/', permanent: true },
      { source: '/docs/:path*', destination: '/:path*', permanent: true },
    ];
  },
  async headers() {
    return [
      {
        // Security headers — all routes
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
        ],
      },
      {
        // Next.js content-hashes every file under /_next/static/ at build time,
        // so these assets are safe to cache for a full year (immutable).
        // The old catch-all `/:path*.(css|js|mjs)` pattern also matched
        // non-hashed files (e.g. /globals.css served directly), which are NOT
        // safe to cache indefinitely — so we scope strictly to /_next/static/.
        source: '/_next/static/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
      {
        // Static media / brand assets — 1-day cache with SWR
        source: '/:path*.(woff2|woff|ttf|otf|svg|png|jpg|jpeg|gif|webp|avif|ico)',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=86400, stale-while-revalidate=604800',
          },
        ],
      },
    ];
  },
};

const withMDX = createMDX();

export default withMDX(nextConfig);
