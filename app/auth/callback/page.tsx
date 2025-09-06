'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  // (optionnel mais clair) force le flow PKCE côté JS
  { auth: { flowType: 'pkce' } } // cf. docs: JS = implicit par défaut, PKCE recommandé. 
);

export default function AuthCallbackPage() {
  const router = useRouter();
  const params = useSearchParams();

  useEffect(() => {
    (async () => {
      // 1) ÉCHANGER LE CODE → créer la session
      const code = params.get('code');
      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) {
          router.replace(`/login?err=${encodeURIComponent(error.message)}`);
          return;
        }
      }

      // 2) Lire l’utilisateur
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.replace('/login'); return; }

      // 3) Vérifier l’identité sur profiles
      const { data: prof } = await supabase
        .from('profiles')
        .select('first_name,last_name')
        .eq('user_id', user.id)
        .maybeSingle();

      // 4) Router selon complétude
      router.replace(!prof?.first_name || !prof?.last_name ? '/check-in' : '/calendrier');
    })();
  }, [router, params]);

  return (
    <div className="min-h-dvh flex items-center justify-center text-zinc-200">
      Connexion…
    </div>
  );
}
