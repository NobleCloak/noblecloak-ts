import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import RootLayout, { dynamic, metadata } from './layout.js';
import Home from './page.js';

describe('home page', () => {
  it('renders the heading and links the health route inside the root layout', () => {
    const html = renderToStaticMarkup(
      <RootLayout>
        <Home />
      </RootLayout>
    );
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<h1>NobleCloak example</h1>');
    expect(html).toContain('href="/api/health"');
    expect(metadata.title).toBe('NobleCloak example');
  });

  it('renders every request: the content-security nonce cannot reach a prerendered page (A14)', () => {
    expect(dynamic).toBe('force-dynamic');
  });

  it('is a server component that renders the client slot provider, so next build checks its directive', () => {
    const source = readFileSync(join(import.meta.dirname, 'layout.tsx'), 'utf8');
    expect(source).not.toMatch(/^\s*['"]use client['"]/);
    expect(source).toContain("import { NcProvider } from '@noblecloak/react/slots';");
    expect(source).toContain('<NcProvider components={{}}>{children}</NcProvider>');
  });
});
