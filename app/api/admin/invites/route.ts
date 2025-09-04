// app/api/admin/invites/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';

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

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const emailsIn: unknown = body?.emails;
    const role: 'doctor' | 'admin' = (body?.role === 'admin' ? 'admin' : 'doctor');

    if (!Array.isArray(emailsIn) || emailsIn.length === 0) {
      return NextResponse.json({ error: 'emails[] requis' }, { status: 400 });
    }

    // Auth admin
    const authHeader = req.headers.get('authorization') || '';
    let access_token: string | null = null;
    if (authHeader.toLowerCase().startsWith('bearer ')) access_token = authHeader.slice(7).trim();
    if (!access_token) access_token = await getAccessTokenFromCookies();
    if (!access_token) return NextResponse.json({ error: 'Auth session missing!' }, { status: 401 });

    const { data: userData, error: userErr } = await supabaseAnon.auth.getUser(access_token);
    if (userErr) return NextResponse.json({ error: userErr.message }, { status: 401 });
    const user = userData.user;
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: isAdmin, error: adminErr } = await supabaseService.rpc('is_admin', { uid: user.id });
    if (adminErr) return NextResponse.json({ error: adminErr.message }, { status: 500 });
    if (!isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    // Normalisation + dédup côté payload
    const cleaned = Array.from(
      new Set(
        emailsIn
          .map((e: any) => String(e || '').trim().toLowerCase())
          .filter((e: string) => e.length > 3 && e.includes('@'))
      )
    );

    const results: Array<{ email: string; status: string; error?: string }> = [];

    for (const email of cleaned) {
      // A) déjà un compte ?
      const { data: exUser, error: exErr } = await supabaseService
        .rpc('user_exists_by_email', { in_email: email });
      if (exErr) throw exErr;
      if (exUser === true) {
        results.push({ email, status: 'already_registered' });
        continue;
      }

      // B) déjà invité chez nous ?
      const { data: existing, error: existErr } = await supabaseService
        .from('invites')
        .select('id, accepted_at')
        .eq('email', email)
        .maybeSingle();
      if (existErr) throw existErr;
      if (existing) {
        results.push({ email, status: existing.accepted_at ? 'already_accepted' : 'already_invited' });
        continue;
      }

      // C) insérer (protégé par unique constraint)
      const { error: insErr } = await supabaseService
        .from('invites')
        .insert({ email, role, invited_by: user.id });
      if (insErr && insErr.code !== '23505') { // 23505 = unique_violation
        results.push({ email, status: 'insert_failed', error: insErr.message });
        continue;
      }

      // D) envoyer l’invitation via l’Admin API (Magic Link d’invitation)
      try {
        const { error: inviteErr } = await supabaseService.auth.admin.inviteUserByEmail(email, {
          data: { role },
          redirectTo: `${SITE_URL}/auth/callback`,
        });
        if (inviteErr) {
          results.push({ email, status: 'invite_failed', error: inviteErr.message });
        } else {
          results.push({ email, status: 'invited' });
        }
      } catch (e: any) {
        results.push({ email, status: 'invite_failed', error: e?.message ?? 'unknown error' });
      }
    }

    return NextResponse.json({
      invited: results.filter(r => r.status === 'invited').length,
      already_registered: results.filter(r => r.status === 'already_registered').length,
      already_invited: results.filter(r => r.status === 'already_invited').length,
      already_accepted: results.filter(r => r.status === 'already_accepted').length,
      failed: results.filter(r => r.status.endsWith('_failed') || r.status === 'insert_failed').length,
      results,
    });
  } catch (e: any) {
    console.error('[admin/invites]', e);
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 });
  }
}
