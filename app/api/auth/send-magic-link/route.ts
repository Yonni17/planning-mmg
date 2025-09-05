// app/api/auth/send-magic-link/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { email: raw } = await req.json().catch(() => ({}));
    const email = String(raw ?? '').trim().toLowerCase();

    if (!email || !email.includes('@')) {
      return NextResponse.json({ error: 'Email invalide' }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();

    // 1) Allowlist via RPC (doit retourner un booléen)
    const { data: allowedByRpc, error: rpcErr } = await supabase.rpc(
      'user_exists_by_email',
      { in_email: email }
    );
    if (rpcErr) {
      // on continue quand même avec le fallback, mais on log
      console.warn('[send-magic-link] RPC error:', rpcErr.message);
    }

    // 2) Fallback: email présent dans invites ET non révoqué
    let allowed = allowedByRpc === true;
    if (!allowed) {
      const { data: invite, error: invErr } = await supabase
        .from('invites')
        .select('status')
        .eq('email', email)
        .maybeSingle();
      if (invErr) {
        return NextResponse.json({ error: invErr.message }, { status: 500 });
      }
      allowed = !!invite && invite.status !== 'revoked';
    }

    if (!allowed) {
      return NextResponse.json(
        { error: "Cet email n'est pas autorisé. Contactez un admin pour être invité." },
        { status: 403 }
      );
    }

    // 3) Envoi du magic link avec le client "anon" créé à la demande
    const siteUrl =
      process.env.NEXT_PUBLIC_SITE_URL ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      return NextResponse.json(
        { error: 'Config serveur incomplète: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY manquants.' },
        { status: 500 }
      );
    }

    // Import local pour éviter tout effet de bord global
    const { createClient } = await import('@supabase/supabase-js');
    const supabaseAnon = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
    });

    const { error: sendErr } = await supabaseAnon.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${siteUrl}/auth/callback` },
    });

    if (sendErr) {
      return NextResponse.json({ error: sendErr.message }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error('[send-magic-link]', e);
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 });
  }
}
