'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type Role = 'admin' | 'doctor' | null;

export default function AuthBar() {
  const [email, setEmail] = useState<string | null>(null);
  const [role, setRole] = useState<Role>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    let mounted = true;

    async function loadSessionAndRole() {
      const { data } = await supabase.auth.getSession();
      if (!mounted) return;

      const user = data.session?.user ?? null;
      setEmail(user?.email ?? null);

      if (user?.id) {
        // Lis le rôle depuis profiles (RLS: l'utilisateur peut lire sa propre ligne)
        const { data: prof } = await supabase
          .from('profiles')
          .select('role')
          .eq('user_id', user.id)
          .maybeSingle();
        setRole((prof?.role as Role) ?? 'doctor');
      } else {
        setRole(null);
      }

      setLoading(false);
    }

    loadSessionAndRole();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, _session) => {
      setEmail(_session?.user?.email ?? null);
      // recharge le rôle à chaque changement d'auth
      if (_session?.user?.id) {
        supabase
          .from('profiles')
          .select('role')
          .eq('user_id', _session.user.id)
          .maybeSingle()
          .then(({ data }) => setRole((data?.role as Role) ?? 'doctor'));
      } else {
        setRole(null);
      }
      router.refresh();
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [router]);

  async function handleLogout() {
    try {
      setLoading(true);
      await supabase.auth.signOut();
      await fetch('/api/auth/signout', { method: 'POST' });
      router.refresh();
      router.push('/');
    } finally {
      setLoading(false);
    }
  }

  const navLink = (href: string, label: string) => {
    const isActive = pathname === href;
    return (
      <Link
        key={href}
        href={href}
        className={[
          'px-3 py-2 rounded-lg text-sm font-medium transition-colors',
          isActive
            ? 'bg-white/10 text-white'
            : 'text-zinc-300 hover:text-white hover:bg-white/5'
        ].join(' ')}
      >
        {label}
      </Link>
    );
  };

  return (
    <header className="sticky top-0 z-50 w-full border-b border-zinc-800 bg-zinc-900/80 backdrop-blur">
      <div className="mx-auto max-w-7xl flex items-center justify-between px-3 py-2">
        <nav className="flex items-center gap-2">
          {navLink('/calendrier', 'Mes disponibilités')}
          {navLink('/preferences', 'Mes préférences')}
          {navLink('/agenda', 'Agenda MMG')}
          {/* Lien Admin unique vers /admin (visible seulement pour role=admin) */}
          {role === 'admin' && navLink('/admin', 'Admin')}
        </nav>

        <div className="flex items-center gap-3">
          {loading ? (
            <div className="text-sm text-zinc-400">…</div>
          ) : !email ? (
            <a
              href="/login"
              className="text-sm px-3 py-1.5 rounded-lg border border-zinc-700 text-zinc-200 hover:bg-white/5 hover:text-white"
            >
              Se connecter
            </a>
          ) : (
            <>
              <span className="text-sm text-zinc-400 hidden sm:inline">
                {email}
              </span>
              <button
                onClick={handleLogout}
                disabled={loading}
                className="text-sm px-3 py-1.5 rounded-lg border border-zinc-700 text-zinc-200 hover:bg-white/5 hover:text-white disabled:opacity-50"
              >
                {loading ? '…' : 'Se déconnecter'}
              </button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
