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
  const tok = await getAccessTokenFromCookies();
  if (!tok) return NextResponse.json({ error: 'Auth session missing!' }, { status: 401 });

  const { data: u } = await supabaseAnon.auth.getUser(tok);
  const email = u.user?.email?.toLowerCase();
  const uid = u.user?.id;
  if (!email || !uid) return NextResponse.json({ error: 'No user' }, { status: 401 });

  // Récupère invite
  const { data: inv } = await supabaseService
    .from('invites')
    .select('full_name, role, status')
    .eq('email', email)
    .maybeSingle();

  // Met à jour profiles si besoin (nom/role)
  if (inv) {
    await supabaseService
      .from('profiles')
      .update({ full_name: inv.full_name, role: inv.role })
      .eq('user_id', uid);

    if (inv.status !== 'accepted') {
      await supabaseService
        .from('invites')
        .update({ status: 'accepted', accepted_at: new Date().toISOString() })
        .eq('email', email);
    }
  }

  return NextResponse.json({ ok: true });
}
