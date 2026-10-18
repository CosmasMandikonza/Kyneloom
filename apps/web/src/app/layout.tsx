import type { Metadata, Viewport } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Kyneloom — Every moment has a world inside',
    template: '%s · Kyneloom',
  },
  description:
    'Kyneloom is an evidence-native experience engine for interactive sports. The visual foundation is real; the Living Replay arrives with the renderer milestone.',
  applicationName: 'Kyneloom',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#101E27',
};

const NAV_ITEMS = [
  { href: '/', label: 'Home' },
  { href: '/moments', label: 'Moments' },
  { href: '/explore', label: 'Explore' },
  { href: '/studio', label: 'Studio' },
] as const;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <header className="site-header">
          <div className="container site-header__inner">
            <Link href="/" className="wordmark" aria-label="Kyneloom home">
              KYNELOOM
            </Link>
            <nav className="site-nav" aria-label="Primary">
              {NAV_ITEMS.map((item) => (
                <Link key={item.href} href={item.href}>
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
