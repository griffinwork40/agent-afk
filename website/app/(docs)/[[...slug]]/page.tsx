import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocsPage, DocsBody, DocsDescription, DocsTitle } from 'fumadocs-ui/page';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { source } from '@/lib/source';
import { SignalField } from '@/components/visual/signal-field';
import { ContourDivider } from '@/components/visual/contour-divider';

interface Props {
  params: Promise<{ slug?: string[] }>;
}

export default async function Page({ params }: Props) {
  const { slug } = await params;
  const page = source.getPage(slug);

  if (!page) notFound();

  const MDX = page.data.body;

  return (
    <DocsPage toc={page.data.toc} full={false}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX
          components={{
            ...defaultMdxComponents,
            Card,
            Cards,
            // Visual signature: the hero motif (signal -> depth -> compression
            // -> rise -> embodiment), available to any page's MDX.
            SignalField,
            // Every thematic break (`---`) across the docs renders as a routed
            // contour transition instead of a flat rule, so all pages inherit
            // the same hand. ContourDivider is also usable explicitly in MDX.
            hr: ContourDivider,
            ContourDivider,
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
  };
}
