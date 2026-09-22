/**
 * OG image for all docs pages.
 *
 * Placed in app/(docs)/ so it covers the entire docs route group.
 * The page title is passed as the `?title=` query param by generateImageMetadata
 * in each child page, falling back to "Agent AFK Docs" when absent.
 *
 * Design language mirrors the docs dark theme:
 *   - bg: #0a0a0a (matches the docs deep-field base)
 *   - brand arc glyph (recreated as JSX — no external asset needed)
 *   - JetBrains Mono wordmark (using system monospace — og images can't load
 *     external fonts from a file path, and vendored WOFF2 can be base64-inlined
 *     if needed later, but system fallback reads well at 1200×630)
 *   - orange accent #fb923c (brand ping colour)
 *   - cool-green accent #4ade80 (brand arc terminus)
 */
import { ImageResponse } from 'next/og';

export const runtime = 'edge';
export const contentType = 'image/png';
export const size = { width: 1200, height: 630 };

export default async function OgImage({
  params,
}: {
  params: { slug?: string[] };
}) {
  // Build a human-readable title from the slug segments.
  // The actual page title isn't available here without re-running the source
  // loader, so we reconstruct a capitalised title from the slug.
  const slugParts = params.slug ?? [];
  const pageTitle =
    slugParts.length > 0
      ? slugParts[slugParts.length - 1]
          .split(/[-_]/)
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ')
      : null;

  const title = pageTitle ?? 'Agent AFK Docs';

  return new ImageResponse(
    (
      <div
        style={{
          width: '1200px',
          height: '630px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          background: '#0a0a0a',
          padding: '72px 80px',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Ambient radial glow — cool green lower-left, orange upper-right */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'radial-gradient(ellipse 60% 50% at 10% 80%, rgba(74,222,128,0.08) 0%, transparent 70%), ' +
              'radial-gradient(ellipse 50% 40% at 90% 20%, rgba(251,146,60,0.10) 0%, transparent 70%)',
          }}
        />

        {/* Top row: brand lockup */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
          }}
        >
          {/* Brand arc glyph (SVG replicated as JSX shapes) */}
          <svg
            width="56"
            height="56"
            viewBox="0 0 64 64"
            style={{ flexShrink: 0 }}
          >
            {/* Arc: a 180°+ arc with green gradient, approximated as a thick
                stroked path. SVG defs/gradients are supported in satori. */}
            <defs>
              <linearGradient id="ogArc" x1="11" y1="42" x2="53" y2="42" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#a0a0b8" />
                <stop offset="40%" stopColor="#6dd5a0" />
                <stop offset="100%" stopColor="#4ade80" />
              </linearGradient>
            </defs>
            <path
              d="M 11 42 A 23 23 0 1 1 53 42"
              fill="none"
              stroke="url(#ogArc)"
              strokeWidth="8"
              strokeLinecap="round"
            />
            {/* Endpoint nodes */}
            <circle cx="11" cy="42" r="4.5" fill="#a0a0b8" />
            <circle cx="53" cy="42" r="4.5" fill="#4ade80" />
            {/* Ping dot */}
            <circle cx="32" cy="52" r="6" fill="#fb923c" />
          </svg>

          {/* Wordmark */}
          <span
            style={{
              fontSize: '28px',
              fontWeight: 500,
              color: '#d4d4d8',
              letterSpacing: '-0.01em',
              fontFamily: 'monospace',
            }}
          >
            agent
            <span style={{ color: '#ffffff', fontWeight: 700 }}>afk</span>
          </span>

          {/* Separator */}
          <span
            style={{
              color: '#3f3f46',
              fontSize: '22px',
              marginLeft: '4px',
            }}
          >
            /
          </span>

          {/* docs label */}
          <span
            style={{
              fontSize: '22px',
              color: '#71717a',
              fontFamily: 'monospace',
            }}
          >
            docs
          </span>
        </div>

        {/* Middle: page title */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            flex: 1,
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              fontSize: title.length > 32 ? '52px' : '64px',
              fontWeight: 700,
              color: '#fafafa',
              fontFamily: 'monospace',
              lineHeight: 1.15,
              letterSpacing: '-0.02em',
              maxWidth: '900px',
            }}
          >
            {title}
          </div>

          {/* Accent underline */}
          <div
            style={{
              width: '80px',
              height: '4px',
              background: '#fb923c',
              borderRadius: '2px',
            }}
          />
        </div>

        {/* Bottom: tagline */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
          }}
        >
          <span
            style={{
              fontSize: '20px',
              color: '#52525b',
              fontFamily: 'monospace',
            }}
          >
            Terminal · Daemon · Telegram — one session
          </span>
        </div>
      </div>
    ),
    {
      ...size,
    }
  );
}
