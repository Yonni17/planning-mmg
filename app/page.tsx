'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import Link from 'next/link';

export default function Home() {
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      setEmail(session?.user?.email ?? null);
      setLoading(false);
    })();
  }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Bienvenue 👋</h1>

      {loading ? (
        <div className="h-10 w-64 rounded bg-slate-200 animate-pulse" />
      ) : email ? (
        <>
          <p>
            Vous êtes connecté : <strong>{email}</strong>.
          </p>
          <div className="flex gap-2">
            <Link
              href="/calendrier"
              className="px-4 py-2 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 shadow"
            >
              Mon calendrier
            </Link>
            <Link
              href="/preferences"
              className="px-4 py-2 rounded-md border border-slate-300 hover:bg-slate-50"
            >
              Préférences
            </Link>
          </div>
        </>
      ) : (
        <>
          <p>
            Utilisez <strong>Se connecter</strong> en haut à droite pour recevoir un lien
            magique par e-mail.
          </p>
          <Link
            href="/login"
            className="inline-block px-4 py-2 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 shadow"
          >
            Se connecter
          </Link>
        </>
      )}
    </div>
  );
}
