import type { ReactNode } from 'react';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { source } from '@/lib/source';
import 'fumadocs-ui/style.css';
import './docs-theme.css';
// Visual signature — a reusable, additive system layered on top of the brand
// theme (signal -> depth -> compression -> rise -> embodiment). Imported AFTER
// docs-theme.css so its scoped overrides sit last in the cascade.
import './signature.css';

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
            // (white, 700). The glyph is a standalone SVG file referenced via
            // <img> (not inlined): Fumadocs renders the title in several nav
            // slots, and an inline SVG would duplicate its gradient ids across
            // those copies — the browser then resolves url(#arc)/url(#ping) to
            // the first (hidden) copy and the arc/ping fills drop out. A file
            // scopes the gradient ids to its own document, so every copy paints.
            // The <img> and wordmark are direct children of Fumadocs' title
            // link so docs-theme.css's `a:hover > .afk-brand-mark` glow applies.
            <>
              {/* eslint-disable-next-line @next/next/no-img-element -- static 32px brand glyph; next/image adds no value */}
              <img
                className="afk-brand-mark"
                src="/brand-mark.svg"
                alt=""
                aria-hidden="true"
                width={32}
                height={32}
              />
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
                <span className="afk-wordmark-agent">agent</span>
                <span className="afk-wordmark-afk">afk</span>
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
