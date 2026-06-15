import type { Metadata } from 'next';
import localFont from 'next/font/local';
import { Analytics } from '@vercel/analytics/next';
import './globals.css';

// JetBrains Mono (variable, latin subset) — vendored under app/fonts/ (OFL-1.1,
// license alongside). Self-hosted via next/font/local: no build-time network
// fetch, no third-party requests at runtime.
const jetbrainsMono = localFont({
  src: './fonts/jetbrains-mono-latin-var.woff2',
  weight: '100 800',
  style: 'normal',
  variable: '--font-jbm',
  display: 'swap',
  adjustFontFallback: false,
  fallback: ['ui-monospace', 'Menlo', 'monospace'],
});

export const metadata: Metadata = {
  title: 'Agent AFK Docs',
  description: 'Documentation for Agent AFK',
  // Favicon: the same "Handoff Arc" mark used on the main site (agentafk.com).
  // SVG primary icon (served from public/favicon.svg) plus the Safari
  // pinned-tab mask-icon reusing the same SVG in the brand orange.
  icons: {
    icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }],
    other: [{ rel: 'mask-icon', url: '/favicon.svg', color: '#f97316' }],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={jetbrainsMono.variable} suppressHydrationWarning>
      <body>{children}<Analytics /></body>
    </html>
  );
}
