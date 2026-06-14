import path from 'node:path';
import type { NextConfig } from 'next';
import { createMDX } from 'fumadocs-mdx/next';

const nextConfig: NextConfig = {
  trailingSlash: false,
  // Pin the file-tracing root to this project so Next doesn't infer the
  // monorepo's pnpm-lock.yaml as the workspace root.
  outputFileTracingRoot: path.resolve(__dirname),
  images: {
    remotePatterns: [],
  },
  async redirects() {
    return [{ source: '/', destination: '/docs', permanent: false }];
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
        // Static JS/CSS assets — short-lived cache with SWR
        source: '/:path*.(css|js|mjs)',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=300, stale-while-revalidate=86400',
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
