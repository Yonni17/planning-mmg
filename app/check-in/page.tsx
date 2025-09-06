'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { supabase } from '@/lib/supabase';

export default function CheckInPage() {
  const router = useRouter();
  const pathname = usePathname();

  const [loading, setLoading] = useState(true);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName]   = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.replace('/login'); return; }

      // Récupère (ou crée) le profil ; si déjà complet -> go calendrier
      const { data: prof } = await supabase
        .from('profiles')
        .select('user_id, first_name, last_name')
        .eq('user_id', user.id)
        .maybeSingle();

      if (prof?.first_name && prof?.last_name) {
        router.replace('/calendrier');
        return;
      }

      if (!prof) {
        // Si pas de ligne -> on en insère une (RLS policies ci-dessus obligatoires)
        const { error } = await supabase.from('profiles').insert({
          user_id: user.id,
          first_name: null,
          last_name: null,
          role: 'doctor',
        } as any);
        if (error) {
          setMsg(`❌ Création du profil impossible: ${error.message}`);
          setLoading(false);
          return;
        }
      }

      setLoading(false);
    })();
  }, [router, pathname]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);

    const fn = firstName.trim();
    const ln = lastName.trim();
    if (!fn || !ln) { setMsg('Merci de renseigner prénom et nom.'); return; }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { router.replace('/login'); return; }

    const { error } = await supabase
      .from('profiles')
      .update({ first_name: fn, last_name: ln })
      .eq('user_id', user.id);

    if (error) { setMsg(`❌ ${error.message}`); return; }

    router.replace('/calendrier');
  };

  if (loading) return <div className="p-6">Chargement…</div>;

  return (
    <div className="min-h-dvh flex items-center justify-center bg-zinc-950">
      <form onSubmit={onSubmit} className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900 p-6 text-zinc-100 shadow-xl">
        <h1 className="text-xl font-semibold mb-4">Bienvenue 👋</h1>
        <p className="text-sm text-zinc-300 mb-4">
          Avant de continuer, merci d’indiquer votre <b>prénom</b> et votre <b>nom</b>.
        </p>

        {msg && <div className="mb-3 rounded border border-red-700 bg-red-900/30 text-red-200 p-2">{msg}</div>}

        <div className="space-y-3">
          <div>
            <label className="block text-sm text-zinc-300 mb-1">Prénom</label>
            <input
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2"
              value={firstName}
              onChange={e => setFirstName(e.target.value)}
              placeholder="Prénom"
            />
          </div>
          <div>
            <label className="block text-sm text-zinc-300 mb-1">Nom</label>
            <input
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2"
              value={lastName}
              onChange={e => setLastName(e.target.value)}
              placeholder="Nom"
            />
          </div>

          <button
            type="submit"
            className="w-full mt-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2"
          >
            Continuer
          </button>
        </div>
      </form>
    </div>
  );
}
