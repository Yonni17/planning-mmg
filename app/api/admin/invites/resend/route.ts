// app/api/admin/invites/resend/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const supabaseService = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function getAccessTokenFromCookies(): Promise<string | null> {
  const store = await cookies();
  const ref = new URL(SUPABASE_URL).host.split('.')[0];
  const base = `sb-${ref}-auth-token`;
  const c0 = store.get(`${base}.0`)?.value ?? '';
  const c1 = store.get(`${base}.1`)?.value ?? '';
  const c = store.get(base)?.value ?? '';
  const raw = c0 || c1 ? `${c0}${c1}` : c;
  if (!raw) return null;
  let txt = raw;
  try { txt = decodeURIComponent(raw); } catch {}
  try {
    const parsed = JSON.parse(txt);
    if (parsed?.access_token) return parsed.access_token as string;
    if (parsed?.currentSession?.access_token) return parsed.currentSession.access_token as string;
  } catch {}
  return null;
}

async function assertAdmin(req: NextRequest) {
  const authHeader = req.headers.get('authorization') || '';
  let tok: string | null = null;
  if (authHeader.toLowerCase().startsWith('bearer ')) tok = authHeader.slice(7).trim();
  if (!tok) tok = await getAccessTokenFromCookies();
  if (!tok) return NextResponse.json({ error: 'Auth session missing!' }, { status: 401 });

  const supabaseAnonLocal = supabaseAnon;
  const { data: userData, error: userErr } = await supabaseAnonLocal.auth.getUser(tok);
  if (userErr || !userData.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: isAdmin, error: adminErr } = await supabaseService.rpc('is_admin', { uid: userData.user.id });
  if (adminErr) return NextResponse.json({ error: adminErr.message }, { status: 500 });
  if (!isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  return { user: userData.user };
}

export async function POST(req: NextRequest) {
  const admin = await assertAdmin(req);
  if (admin instanceof NextResponse) return admin;

  try {
    const { email } = await req.json();
    const em = String(email ?? '').trim().toLowerCase();
    if (!em) return NextResponse.json({ error: 'email requis' }, { status: 400 });

    const { data: inv, error: invErr } = await supabaseService
      .from('invites')
      .select('email,status')
      .eq('email', em)
      .maybeSingle();
    if (invErr) return NextResponse.json({ error: invErr.message }, { status: 500 });
    if (!inv) return NextResponse.json({ error: 'Invitation introuvable' }, { status: 404 });
    if (inv.status === 'revoked') return NextResponse.json({ error: 'Invitation révoquée' }, { status: 400 });

    const redirectTo =
      (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000') + '/auth/callback';

    const { error: otpErr } = await supabaseAnon.auth.signInWithOtp({
      email: em,
      options: { emailRedirectTo: redirectTo }
    });
    if (otpErr) return NextResponse.json({ error: otpErr.message }, { status: 500 });

    const { error: updErr } = await supabaseService
      .from('invites')
      .update({ status: 'sent', last_sent_at: new Date().toISOString() })
      .eq('email', em);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 });
  }
}
