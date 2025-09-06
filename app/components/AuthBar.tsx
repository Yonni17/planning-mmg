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

type ProfileRow = {
  first_name: string | null;
  last_name: string | null;
  role: Role;
} | null;

export default function AuthBar() {
  const router = useRouter();
  const pathname = usePathname();

  const [email, setEmail] = useState<string | null>(null);
  const [role, setRole] = useState<Role>(null);
  const [profile, setProfile] = useState<ProfileRow>(null);
  const [loading, setLoading] = useState(true);

  // Cache complètement la barre sur la route de check-in
  if (pathname?.startsWith('/check-in')) return null;

  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoading(true);

      const { data: { session } } = await supabase.auth.getSession();
      if (!mounted) return;

      const user = session?.user ?? null;
      setEmail(user?.email ?? null);

      if (user?.id) {
        const { data: prof } = await supabase
          .from('profiles')
          .select('first_name, last_name, role')
          .eq('user_id', user.id)
          .maybeSingle();

        setProfile(prof ?? null);
        setRole((prof?.role as Role) ?? 'doctor');
      } else {
        setProfile(null);
        setRole(null);
      }

      setLoading(false);
    }

    load();

    const { data: subscription } = supabase.auth.onAuthStateChange(async () => {
      await load();
      router.refresh();
    });

    return () => {
      mounted = false;
      subscription.subscription.unsubscribe();
    };
  }, [router]);

  const incomplete = !!email && (!!profile?.first_name === false || !!profile?.last_name === false);

  async function handleLogout() {
    try {
      setLoading(true);
      await supabase.auth.signOut();
      await fetch('/api/auth/signout', { method: 'POST' }).catch(() => {});
      router.push('/');
      router.refresh();
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

  // Construire le menu en fonction de l'état
  const renderNav = () => {
    if (!email) {
      // Non connecté : pas de liens "app"
      return null;
    }

    if (incomplete) {
      // Profil incomplet : on ne laisse que l'accès aux préférences/check-in
      return (
        <nav className="flex items-center gap-2">
          {navLink('/check-in', 'Mes préférences')}
        </nav>
      );
    }

    // Profil complet : liens normaux
    return (
      <nav className="flex items-center gap-2">
        {navLink('/calendrier', 'Mes disponibilités')}
        {navLink('/preferences', 'Mes préférences')}
        {navLink('/agenda', 'Agenda MMG')}
        {role === 'admin' && navLink('/admin', 'Admin')}
      </nav>
    );
  };

  return (
    <header className="sticky top-0 z-50 w-full border-b border-zinc-800 bg-zinc-900/80 backdrop-blur">
      <div className="mx-auto max-w-7xl flex items-center justify-between px-3 py-2">
        {renderNav()}

        <div className="flex items-center gap-3">
          {loading ? (
            <div className="text-sm text-zinc-400">…</div>
          ) : !email ? (
            <Link
              href="/login"
              className="text-sm px-3 py-1.5 rounded-lg border border-zinc-700 text-zinc-200 hover:bg-white/5 hover:text-white"
            >
              Se connecter
            </Link>
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
