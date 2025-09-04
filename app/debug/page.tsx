'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

export default function DebugPage() {
  const [state, setState] = useState<any>({ loading: true });

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const user = session?.user ?? null;
      let profile = null, profilesError = null;

      if (user) {
        const { data, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('user_id', user.id)
          .single();
        profile = data ?? null;
        profilesError = error?.message ?? null;
      }

      setState({
        loading: false,
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
        user,
        profile,
        profilesError,
      });
    })();
  }, []);

  return (
    <div style={{maxWidth: 800, margin: '24px auto'}}>
      <h1>Debug</h1>
      <pre style={{whiteSpace:'pre-wrap', fontSize:12, background:'#f7f7f7', padding:12, borderRadius:8}}>
        {JSON.stringify(state, null, 2)}
      </pre>
      <p>• Ouvre la console (F12) pour voir d’éventuelles erreurs réseau.</p>
    </div>
  );
}
