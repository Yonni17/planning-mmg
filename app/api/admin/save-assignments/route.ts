import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@supabase/supabase-js';

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

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { period_id, rows } = body ?? {};
    if (!period_id || !Array.isArray(rows)) {
      return NextResponse.json({ error: 'period_id et rows[] requis' }, { status: 400 });
    }

    // Auth & admin
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

    // Purge + insert
    const { error: delErr } = await supabaseService.from('assignments').delete().eq('period_id', period_id);
    if (delErr) throw delErr;

    const insertRows = rows.map((r: any) => ({
      period_id,
      slot_id: r.slot_id,
      user_id: r.user_id,
      score: r.score ?? 0,
    }));

    if (insertRows.length) {
      const { error: insErr } = await supabaseService.from('assignments').insert(insertRows);
      if (insErr) throw insErr;
    }

    return NextResponse.json({ ok: true, inserted: insertRows.length });
  } catch (e: any) {
    console.error('[save-assignments]', e);
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 });
  }
}
