// app/api/auth/signout/route.ts
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

export async function POST() {
  const store = await cookies();

  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const host = new URL(url).host; // ex: etpczhpmcfedhcfnjxes.supabase.co
    const ref = host.split('.')[0];
    const base = `sb-${ref}-auth-token`;

    // Purge les variantes possibles
    const names = [base, `${base}.0`, `${base}.1`, 'supabase-auth-token'];

    for (const name of names) {
      // Supprime avec maxAge 0 (Next 15)
      store.set({
        name,
        value: '',
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 0,
      });
    }

    // Optionnel: si tu avais défini un cookie de session custom, purge-le ici

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'error' }, { status: 500 });
  }
}
