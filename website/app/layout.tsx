import type { Metadata } from 'next';
import localFont from 'next/font/local';
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
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={jetbrainsMono.variable}>
      <body>{children}</body>
    </html>
  );
}
