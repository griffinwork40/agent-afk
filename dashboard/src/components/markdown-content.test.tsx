import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkdownContent } from './markdown-content';

/**
 * Scheme allowlist tests for the `a` renderer in MarkdownContent.
 *
 * Allowed: https://, http://, root-relative (/path), anchor (#anchor).
 * Blocked: data:, javascript:, protocol-relative (//evil.com), undefined href.
 *
 * react-markdown wraps inline content in a <p>; we query within that.
 */

function renderLink(href: string) {
  // Produce a markdown link with a known label
  return render(<MarkdownContent text={`[click me](${href})`} />);
}

describe('MarkdownContent – scheme allowlist', () => {
  describe('allowed schemes → renders <a>', () => {
    it('renders https:// URLs as an anchor', () => {
      renderLink('https://example.com');
      const link = screen.getByRole('link', { name: 'click me' });
      expect(link).toBeInTheDocument();
      expect(link.tagName).toBe('A');
      expect(link).toHaveAttribute('href', 'https://example.com');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('renders http:// URLs as an anchor', () => {
      renderLink('http://example.com');
      const link = screen.getByRole('link', { name: 'click me' });
      expect(link).toBeInTheDocument();
      expect(link.tagName).toBe('A');
      expect(link).toHaveAttribute('href', 'http://example.com');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('renders root-relative paths as an anchor', () => {
      renderLink('/path');
      const link = screen.getByRole('link', { name: 'click me' });
      expect(link).toBeInTheDocument();
      expect(link.tagName).toBe('A');
      expect(link).toHaveAttribute('href', '/path');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('renders anchor links (#fragment) as an anchor', () => {
      renderLink('#anchor');
      const link = screen.getByRole('link', { name: 'click me' });
      expect(link).toBeInTheDocument();
      expect(link.tagName).toBe('A');
      expect(link).toHaveAttribute('href', '#anchor');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });
  });

  describe('blocked schemes → renders <span> (no anchor)', () => {
    it('blocks data: URIs', () => {
      renderLink('data:text/html,<script>alert(1)</script>');
      expect(screen.queryByRole('link')).toBeNull();
      expect(screen.getByText('click me').tagName).toBe('SPAN');
    });

    it('blocks javascript: URIs', () => {
      renderLink('javascript:alert(1)');
      expect(screen.queryByRole('link')).toBeNull();
      expect(screen.getByText('click me').tagName).toBe('SPAN');
    });

    it('blocks protocol-relative URLs (//evil.com)', () => {
      renderLink('//evil.com');
      expect(screen.queryByRole('link')).toBeNull();
      expect(screen.getByText('click me').tagName).toBe('SPAN');
    });
  });

  describe('edge cases', () => {
    it('renders anchor safely when href is an empty string', () => {
      // react-markdown passes href="" for [text](); the guard `href && /…/.test(href)`
      // is falsy for empty string, so the component must degrade to <span>.
      render(<MarkdownContent text="[click me]()" />);
      expect(screen.queryByRole('link')).toBeNull();
      expect(screen.getByText('click me').tagName).toBe('SPAN');
    });
  });
});
