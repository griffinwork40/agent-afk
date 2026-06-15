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
            <span style={{ fontFamily: 'var(--font-jbm, monospace)', fontWeight: 600 }}>
              <span style={{ color: 'var(--color-text, #e9e9f0)' }}>agent</span>
              <span style={{ color: 'var(--color-accent, #f9854b)' }}>afk</span>
            </span>
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
