import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocsPage, DocsBody, DocsDescription, DocsTitle } from 'fumadocs-ui/page';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { getBreadcrumbItems } from 'fumadocs-core/breadcrumb';
import { source } from '@/lib/source';
import {
  SignatureField,
  SignalField,
  ExtractField,
  ElevatedField,
  Threshold,
} from '../_components/signature';

interface Props {
  params: Promise<{ slug?: string[] }>;
}

/** SoftwareApplication JSON-LD for the homepage. */
const SOFTWARE_APP_LD = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Agent AFK',
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'macOS, Linux',
  url: 'https://docs.agentafk.com',
  sameAs: 'https://agentafk.com',
  description:
    'Agent AFK is an open-source AI agent runtime: terminal REPL, headless daemon, and Telegram bot — sharing one session, memory, and tool surface.',
  offers: {
    '@type': 'Offer',
    price: '0',
    priceCurrency: 'USD',
  },
  downloadUrl: 'https://www.npmjs.com/package/agent-afk',
  softwareVersion: 'latest',
  author: {
    '@type': 'Person',
    name: 'Griffin Long',
    url: 'https://griffinlong.substack.com',
  },
});

/** Build BreadcrumbList JSON-LD from a page URL and the docs tree. */
function buildBreadcrumbLd(pageUrl: string, pageTitle: string) {
  const tree = source.getPageTree();

  // Get folder ancestors (no includePage so we don't double-count the page itself)
  const ancestorItems = getBreadcrumbItems(pageUrl, tree, {
    includePage: false,
    includeRoot: false,
  });

  // Compose the full item list: "Docs" root + ancestors + current page
  const fullItems = [
    { name: 'Docs', url: 'https://docs.agentafk.com/' },
    ...ancestorItems.map((item) => ({
      name: item.name,
      url: item.url ? `https://docs.agentafk.com${item.url}` : undefined,
    })),
    {
      name: pageTitle,
      url: `https://docs.agentafk.com${pageUrl}`,
    },
  ];

  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: fullItems.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      ...(item.url ? { item: item.url } : {}),
    })),
  });
}

export default async function Page({ params }: Props) {
  const { slug } = await params;
  const page = source.getPage(slug);

  if (!page) notFound();

  const MDX = page.data.body;
  const isHomepage = !slug || slug.length === 0;

  const breadcrumbLd = buildBreadcrumbLd(page.url, page.data.title);

  return (
    <DocsPage toc={page.data.toc} full={false}>
      {/* Ambient signature backdrop — the submerged topographic field that
          sits behind every docs page (deep-field + drifting contour-layer).
          Pure presentation, aria-hidden, pointer-events:none. */}
      <SignatureField />

      {/* JSON-LD structured data */}
      {isHomepage && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: SOFTWARE_APP_LD }}
        />
      )}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: breadcrumbLd }}
      />

      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX
          components={{
            ...defaultMdxComponents,
            Card,
            Cards,
            // Signature wrappers, available to any MDX page.
            SignalField,
            ExtractField,
            ElevatedField,
            Threshold,
          }}
        />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
    alternates: {
      canonical: page.url,
    },
    openGraph: {
      title: page.data.title,
      description: page.data.description,
      url: page.url,
      type: 'article',
    },
    twitter: {
      card: 'summary_large_image',
      title: page.data.title,
      description: page.data.description,
    },
  };
}
