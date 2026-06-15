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
          url: '/',
        }}
        sidebar={{
          defaultOpenLevel: 1,
        }}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
