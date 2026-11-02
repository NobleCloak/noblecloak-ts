import { NcProvider } from '@noblecloak/react/slots';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// Every page is rendered per request: the content-security policy carries a nonce that is new for each response,
// and a page prerendered at build time could not carry it.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'NobleCloak example',
  description: 'The fixture app NobleCloak modules are installed into.',
};

// This layout is a server component that renders the slot provider, so the provider must reach it as a client
// reference: `@noblecloak/react/slots` starts with a `'use client'` directive (checked by `check-react-dist`), and
// so does the `@noblecloak/theme` entry it re-exports (its tsup banner). With neither, `next build` fails on this
// file, so the example's build checks that the server-component import works. The map is empty because a
// replacement is a function, which cannot pass from a server component to a client one: a provider with
// replacements goes in a client component (the package README's "Bring your own components").
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <NcProvider components={{}}>{children}</NcProvider>
      </body>
    </html>
  );
}
