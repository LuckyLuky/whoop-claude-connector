import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'WHOOP · Claude connector',
  description: 'Remote MCP server exposing WHOOP data to Claude.',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
