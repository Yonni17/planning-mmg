// app/api/admin/invites/resend/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** ---- Helpers auth (Bearer ou cookies Supabase) ---- */
function getAccessTokenFromReq(req: NextRequest): string | null {
  // 1) Authorization: Bearer <jwt>
  const auth = req.headers.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

  // 2) Cookie direct sb-access-token (supabase-js côté client)
  const c = cookies();
  const direct = c.get('sb-access-token')?.value;
  if (direct) return direct;

  // 3) Cookie objet sb-<ref>-auth-token (Helpers) éventuellement splitté .0/.1
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
  try {
    const ref = new URL(supabaseUrl).host.split('.')[0];
    const base = `sb-${ref}-auth-token`;
    const c0 = c.get(`${base}.0`)?.value ?? '';
    const c1 = c.get(`${base}.1`)?.value ?? '';
    const cj = c.get(base)?.value ?? '';
    const raw = c0 || c1 ? `${c0}${c1}` : cj;
    if (!raw) return null;

    let txt = raw;
    try {
      txt = decodeURIComponent(raw);
    } catch {}
    const parsed = JSON.parse(txt);
    if (parsed?.access_token) return String(parsed.access_token);
    if (parsed?.currentSession?.access_token)
      return String(parsed.currentSession.access_token);
  } catch {
    // ignore
  }
  return null;
}

async function requireAdminOrResponse(req: NextRequest) {
  const supabase = getSupabaseAdmin();

  const token = getAccessTokenFromReq(req);
  if (!token) {
    return {
      errorResponse: NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      ),
      supabase,
      userId: null as string | null,
    };
  }

  const { data: userData, error: uErr } = await supabase.auth.getUser(token);
  if (uErr || !userData?.user) {
    return {
      errorResponse: NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      ),
      supabase,
      userId: null,
    };
  }

  const uid = userData.user.id;
  const { data: isAdmin, error: aErr } = await supabase.rpc('is_admin', { uid });
  if (aErr || !isAdmin) {
    return {
      errorResponse: NextResponse.json(
        { error: 'Forbidden' },
        { status: 403 }
      ),
      supabase,
      userId: uid,
    };
  }

  return { errorResponse: null as NextResponse | null, supabase, userId: uid };
}

/** ---- Handler ---- */
export async function POST(req: NextRequest) {
  const auth = await requireAdminOrResponse(req);
  if (auth.errorResponse) return auth.errorResponse;
  const supabase = auth.supabase;

  try {
    const body = await req.json().catch(() => ({}));
    const email = String(body?.email ?? '').trim().toLowerCase();
    if (!email) {
      return NextResponse.json({ error: 'email requis' }, { status: 400 });
    }

    // Vérifier l'invitation
    const { data: inv, error: invErr } = await supabase
      .from('invites')
      .select('email,status')
      .eq('email', email)
      .maybeSingle();

    if (invErr) {
      return NextResponse.json({ error: invErr.message }, { status: 500 });
    }
    if (!inv) {
      return NextResponse.json(
        { error: 'Invitation introuvable' },
        { status: 404 }
      );
    }
    if ((inv as any).status === 'revoked') {
      return NextResponse.json(
        { error: 'Invitation révoquée' },
        { status: 400 }
      );
    }

    // URL de redirection pour le lien magique
    const siteUrl =
      process.env.NEXT_PUBLIC_SITE_URL ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
    const redirectTo = `${siteUrl}/auth/callback`;

    // Envoi lien magique via client ANON (créé ici, pas au top-level)
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anon) throw new Error('Supabase env (URL/ANON) manquante');

    const supabaseAnon = createClient(url, anon, { auth: { persistSession: false } });
    const { error: otpErr } = await supabaseAnon.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    });
    if (otpErr) {
      return NextResponse.json({ error: otpErr.message }, { status: 500 });
    }

    // Mise à jour de l'invite (si colonnes présentes)
    const { error: updErr } = await supabase
      .from('invites')
      .update({ status: 'sent', last_sent_at: new Date().toISOString() })
      .eq('email', email);

    if (updErr) {
      // Non bloquant si votre schéma n'a pas ces colonnes — commentez ce bloc si besoin
      return NextResponse.json({ error: updErr.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? 'Server error' },
      { status: 500 }
    );
  }
}
