// app/api/availability/validate-month/route.ts
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
    try { txt = decodeURIComponent(raw); } catch {}
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
  try {
    const supabase = getSupabaseAdmin();

    const payload = await req.json().catch(() => ({}));
    const period_id = String((payload as any)?.period_id ?? '').trim();
    const month = String((payload as any)?.month ?? '').trim(); // YYYY-MM
    const validated = (payload as any)?.validated;

    if (!period_id || !month || typeof validated !== 'boolean') {
      return NextResponse.json(
        { error: 'period_id, month (YYYY-MM) et validated requis' },
        { status: 400 }
      );
    }

    // Auth (Bearer ou cookies)
    const token = getAccessTokenFromReq(req);
    if (!token) {
      return NextResponse.json({ error: 'Auth session missing!' }, { status: 401 });
    }

    const { data: userData, error: uErr } = await supabase.auth.getUser(token);
    if (uErr || !userData?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const uid = userData.user.id;

    // Si une ligne existe déjà et qu’elle est verrouillée ou opt-out => on interdit la modif
    const { data: existing, error: exErr } = await supabase
      .from('doctor_period_months')
      .select('locked, opted_out')
      .eq('user_id', uid)
      .eq('period_id', period_id)
      .eq('month', month)
      .maybeSingle();

    if (exErr) {
      return NextResponse.json({ error: exErr.message }, { status: 500 });
    }
    if (existing?.locked) {
      return NextResponse.json(
        { error: 'Mois verrouillé. Déverrouillage requis par un admin.' },
        { status: 409 }
      );
    }
    if (existing?.opted_out) {
      return NextResponse.json(
        { error: 'Mois marqué comme “opt-out”. Contactez un admin pour réactiver.' },
        { status: 409 }
      );
    }

    // Upsert (clé composite (user_id, period_id, month))
    const row = {
      user_id: uid,
      period_id,
      month,
      validated_at: validated ? new Date().toISOString() : null,
      // on ne touche pas à "locked" ni "opted_out" ici
    };

    const { data, error } = await supabase
      .from('doctor_period_months')
      .upsert(row, { onConflict: 'user_id,period_id,month' })
      .select()
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data ?? row);
  } catch (e: any) {
    console.error('[availability/validate-month]', e);
    return NextResponse.json(
      { error: e?.message ?? 'Server error' },
      { status: 500 }
    );
  }
}
