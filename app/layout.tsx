import './globals.css';
import type { Metadata, Viewport } from 'next';
import AuthBar from './components/AuthBar';

export const metadata: Metadata = {
  title: 'Planning MMG',
  description: '…',
  applicationName: 'Planning MMG',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)',  color: '#0a0a0a' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body className="min-h-dvh bg-zinc-950 text-zinc-100 antialiased">
        {/* Unique barre de navigation */}
        <AuthBar />

        {/* Contenu */}
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          {children}
        </main>

        <Footer />
      </body>
    </html>
  );
}

function Footer() {
  return (
    <footer className="border-t border-zinc-800 mt-10">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 text-xs text-zinc-400">
        © {new Date().getFullYear()} Planning MMG
      </div>
    </footer>
  );
}