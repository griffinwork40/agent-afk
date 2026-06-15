import type { ReactNode } from 'react';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { source } from '@/lib/source';
import 'fumadocs-ui/style.css';
import './docs-theme.css';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <RootProvider
      theme={{
        // Force dark mode to always match the site's dark terminal aesthetic.
        // next-themes will still allow user override via localStorage.
        defaultTheme: 'dark',
      }}
    >
      <DocsLayout
        tree={source.getPageTree()}
        nav={{
          title: (
            // Brand lockup mirrors agentafk.com's navbar: the "Handoff Arc"
            // glyph + the sans wordmark "agent" (light grey, 500) / "afk"
            // (white, 700). The glyph and wordmark are direct children of
            // Fumadocs' title link so the hover-glow rule in docs-theme.css
            // (a:hover > .afk-brand-mark) can target the glyph.
            <>
              <svg
                className="afk-brand-mark"
                viewBox="0 0 64 64"
                width={32}
                height={32}
                role="img"
                aria-label="Agent AFK"
              >
                <defs>
                  <linearGradient
                    id="afk-nav-arc"
                    x1="14"
                    y1="48"
                    x2="50"
                    y2="48"
                    gradientUnits="userSpaceOnUse"
                  >
                    <stop offset="0%" stopColor="#8a8aa0" />
                    <stop offset="50%" stopColor="#74bc90" />
                    <stop offset="100%" stopColor="#5cb87f" />
                  </linearGradient>
                  <radialGradient id="afk-nav-ping" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="#ffc2a1" />
                    <stop offset="55%" stopColor="#f97316" />
                    <stop offset="100%" stopColor="#d65a0e" />
                  </radialGradient>
                </defs>
                <path
                  d="M 14 48 A 24 24 0 1 1 50 48"
                  fill="none"
                  stroke="url(#afk-nav-arc)"
                  strokeWidth="7"
                  strokeLinecap="round"
                />
                <circle cx="14" cy="48" r="4.5" fill="#8a8aa0" />
                <circle cx="50" cy="48" r="4.5" fill="#5cb87f" />
                <circle cx="32" cy="56" r="5" fill="url(#afk-nav-ping)" />
              </svg>
              <span
                style={{
                  fontFamily:
                    '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", "Helvetica Neue", Arial, sans-serif',
                  fontSize: '19px',
                  letterSpacing: '-0.01em',
                  display: 'inline-flex',
                  alignItems: 'baseline',
                }}
              >
                <span style={{ fontWeight: 500, color: '#e9e9f0' }}>agent</span>
                <span style={{ fontWeight: 700, color: '#ffffff' }}>afk</span>
              </span>
            </>
          ),
          // Brand wordmark links out to the landing page (agentafk.com), not
          // the docs home — clicking the logo returns to the main site.
          url: 'https://agentafk.com',
        }}
        // Nav links: the landing page (agentafk.com) and the GitHub repo.
        // These docs are served at the docs.agentafk.com subdomain, so link
        // back out to the main site; githubUrl renders Fumadocs' built-in
        // GitHub icon button (no extra icon import needed).
        links={[
          {
            text: 'agentafk.com',
            url: 'https://agentafk.com',
          },
        ]}
        githubUrl="https://github.com/griffinwork40/agent-afk"
        sidebar={{
          defaultOpenLevel: 1,
        }}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
