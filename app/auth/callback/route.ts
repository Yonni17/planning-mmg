import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');

  const cookieStore = cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get: (name) => cookieStore.get(name)?.value,
        set: (name, value, options) => cookieStore.set({ name, value, ...options }),
        remove: (name, options) => cookieStore.set({ name, value: '', ...options, maxAge: 0 }),
      },
    }
  );

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return NextResponse.redirect(new URL(`/login?err=${encodeURIComponent(error.message)}`, url.origin));
    }
  }

  // On a maintenant la session → on peut router selon le profil
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL('/login', url.origin));
  }

  const { data: prof } = await supabase
    .from('profiles')
    .select('first_name,last_name')
    .eq('user_id', user.id)
    .maybeSingle();

  const next = (!prof?.first_name || !prof?.last_name) ? '/check-in' : '/calendrier';
  return NextResponse.redirect(new URL(next, url.origin));
}
