import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "agent-afk | Autonomous AI Agent Runtime",
  description:
    "Start a task and walk away. agent-afk orchestrates parallel sub-agents across isolated git branches, tracks every decision in a durable witness trace, and texts you when it's done.",
  openGraph: {
    title: "agent-afk | Autonomous AI Agent Runtime",
    description:
      "Start a task and walk away. agent-afk orchestrates parallel sub-agents, tracks decisions, and texts you when it's done.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased font-mono">{children}</body>
    </html>
  );
}
