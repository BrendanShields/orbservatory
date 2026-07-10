import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Orbservatory — Claude Code live visualiser',
  description: 'A local live visualiser for agent coding sessions.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
