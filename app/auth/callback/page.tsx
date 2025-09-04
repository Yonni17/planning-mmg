'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export default function AuthCallbackPage() {
  const router = useRouter();

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) {
        router.replace('/login');
        return;
      }
      // On lit le profil pour savoir si first/last sont présents
      const { data: prof } = await supabase
        .from('profiles')
        .select('first_name, last_name')
        .eq('user_id', session.user.id)
        .maybeSingle();

      if (!prof?.first_name || !prof?.last_name) {
        router.replace('/preferences'); // forcer la complétion d’identité
      } else {
        router.replace('/calendrier');  // sinon page habituelle
      }
    })();
  }, [router]);

  return (
    <div className="min-h-dvh flex items-center justify-center text-zinc-200">
      Connexion…
    </div>
  );
}
