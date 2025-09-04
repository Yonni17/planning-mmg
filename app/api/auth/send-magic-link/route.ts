// app/api/auth/send-magic-link/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';

const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const supabaseService = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

export async function POST(req: NextRequest) {
  try {
    const { email: raw } = await req.json();
    const email = String(raw || '').trim().toLowerCase();

    if (!email || !email.includes('@')) {
      return NextResponse.json({ error: 'Email invalide' }, { status: 400 });
    }

    // 1) Déjà un compte ?
    const { data: existsUser, error: existsErr } = await supabaseService
      .rpc('user_exists_by_email', { in_email: email });
    if (existsErr) {
      return NextResponse.json({ error: existsErr.message }, { status: 500 });
    }

    // 2) Ou bien déjà invité ?
    let allowed = existsUser === true;
    if (!allowed) {
      const { data: invite, error: invErr } = await supabaseService
        .from('invites')
        .select('id, accepted_at')
        .eq('email', email)
        .maybeSingle();
      if (invErr) {
        return NextResponse.json({ error: invErr.message }, { status: 500 });
      }
      allowed = !!invite; // si présent dans invites, on autorise l’envoi
    }

    if (!allowed) {
      return NextResponse.json(
        { error: "Cet email n'est pas autorisé. Contactez un admin pour être invité." },
        { status: 403 }
      );
    }

    // 3) Envoi du magic link
    const { error: sendErr } = await supabaseAnon.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${SITE_URL}/auth/callback`,
      },
    });

    if (sendErr) {
      return NextResponse.json({ error: sendErr.message }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 });
  }
}
