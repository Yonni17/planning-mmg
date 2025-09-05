// app/api/auth/after-login/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* -------------------- Auth helpers (Bearer / Cookies) -------------------- */
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

/* ------------------------------ Handler --------------------------------- */
export async function POST(req: NextRequest) {
  const supabase = getSupabaseAdmin();

  // Auth utilisateur (JWT depuis Bearer ou cookies supabase)
  const token = getAccessTokenFromReq(req);
  if (!token) {
    return NextResponse.json({ error: 'Auth session missing!' }, { status: 401 });
  }

  const { data: userData, error: uErr } = await supabase.auth.getUser(token);
  if (uErr || !userData?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const uid = userData.user.id;
  const email = (userData.user.email || '').toLowerCase();
  if (!uid || !email) {
    return NextResponse.json({ error: 'No user' }, { status: 401 });
  }

  // Récupère l’invitation (si elle existe) pour connaître le rôle souhaité
  const { data: inv, error: invErr } = await supabase
    .from('invites')
    .select('role, status')
    .eq('email', email)
    .maybeSingle();

  if (invErr) {
    // Pas bloquant, mais on remonte l’erreur pour debug
    console.warn('[after-login] invites read error:', invErr.message);
  }

  // Assurer/mettre à jour le profil (role uniquement ici ; prénom/nom sur page /preferences)
  if (inv?.role) {
    // upsert pour créer la ligne si nécessaire, sans toucher first_name/last_name
    const { error: upErr } = await supabase
      .from('profiles')
      .upsert(
        { user_id: uid, role: inv.role },
        { onConflict: 'user_id' }
      );
    if (upErr) {
      console.warn('[after-login] profiles upsert error:', upErr.message);
    }
  }

  // Marquer l’invitation comme acceptée si ce n’est pas déjà fait
  if (inv && inv.status !== 'accepted') {
    const { error: updErr } = await supabase
      .from('invites')
      .update({ status: 'accepted', accepted_at: new Date().toISOString() })
      .eq('email', email);
    if (updErr) {
      console.warn('[after-login] invites update error:', updErr.message);
    }
  }

  return NextResponse.json({ ok: true });
}
