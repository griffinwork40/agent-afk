import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocsPage, DocsBody, DocsDescription, DocsTitle } from 'fumadocs-ui/page';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import { Card, Cards } from 'fumadocs-ui/components/card';
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

export default async function Page({ params }: Props) {
  const { slug } = await params;
  const page = source.getPage(slug);

  if (!page) notFound();

  const MDX = page.data.body;

  return (
    <DocsPage toc={page.data.toc} full={false}>
      {/* Ambient signature backdrop — the submerged topographic field that
          sits behind every docs page (deep-field + drifting contour-layer).
          Pure presentation, aria-hidden, pointer-events:none. */}
      <SignatureField />
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
  };
}
