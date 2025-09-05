// app/api/doctor-months/route.ts
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

/* ---------------------- Utils ---------------------- */
function yyyymm(dateStr: string): string {
  // dateStr attendu: 'YYYY-MM-DD'
  return dateStr.slice(0, 7);
}

type MonthState = {
  month: string;                // 'YYYY-MM'
  validated_at: string | null;  // ISO or null
  locked: boolean;
  opted_out: boolean;
};

function computeFlags(rows: MonthState[]) {
  const total = rows.length;
  const all_validated =
    total > 0 && rows.every(r => !!r.validated_at || r.opted_out);
  const opted_out =
    total > 0 && rows.every(r => r.opted_out);
  const locked = rows.some(r => r.locked);
  return { all_validated, opted_out, locked };
}

/* ------------------------------ GET --------------------------------- */
/**
 * GET /api/doctor-months?period_id=...
 * -> Renvoie les mois présents dans la période + l'état de l'utilisateur courant
 *    et des flags agrégés { all_validated, opted_out, locked }
 */
export async function GET(req: NextRequest) {
  try {
    const supabase = getSupabaseAdmin();

    const { searchParams } = new URL(req.url);
    const period_id = String(searchParams.get('period_id') ?? '').trim();
    if (!period_id) {
      return NextResponse.json({ error: 'period_id requis' }, { status: 400 });
    }

    // Auth
    const token = getAccessTokenFromReq(req);
    if (!token) {
      return NextResponse.json({ error: 'Auth session missing!' }, { status: 401 });
    }
    const { data: userData, error: uErr } = await supabase.auth.getUser(token);
    if (uErr || !userData?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const uid = userData.user.id;

    // 1) Mois présents dans la période (d’après slots.date)
    const { data: slotRows, error: slotsErr } = await supabase
      .from('slots')
      .select('date')
      .eq('period_id', period_id);
    if (slotsErr) {
      return NextResponse.json({ error: slotsErr.message }, { status: 500 });
    }

    const monthSet = new Set<string>();
    for (const s of slotRows ?? []) {
      const d = (s as any).date as string | null;
      if (d) monthSet.add(yyyymm(d));
    }
    const months = Array.from(monthSet).sort();

    // 2) État utilisateur pour ces mois
    const { data: dpmRows, error: dpmErr } = await supabase
      .from('doctor_period_months')
      .select('month, validated_at, locked, opted_out')
      .eq('user_id', uid)
      .eq('period_id', period_id);
    if (dpmErr) {
      return NextResponse.json({ error: dpmErr.message }, { status: 500 });
    }

    const byMonth = new Map<string, MonthState>();
    for (const r of dpmRows ?? []) {
      const row = r as any;
      byMonth.set(row.month, {
        month: row.month,
        validated_at: row.validated_at ?? null,
        locked: !!row.locked,
        opted_out: !!row.opted_out,
      });
    }

    const monthsOut: MonthState[] = months.map(m => {
      const r = byMonth.get(m);
      return r ?? { month: m, validated_at: null, locked: false, opted_out: false };
    });

    const flags = computeFlags(monthsOut);

    return NextResponse.json({
      period_id,
      months: monthsOut,
      flags,
    });
  } catch (e: any) {
    console.error('[doctor-months GET]', e);
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 });
  }
}

/* ------------------------------ POST -------------------------------- */
/**
 * POST /api/doctor-months
 * body:
 *   { action: 'toggle_validate', period_id, month | month_key, value: boolean }
 *   { action: 'opt_out',        period_id, value: boolean }
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = getSupabaseAdmin();

    const body = await req.json().catch(() => ({}));
    const action = String((body as any)?.action ?? '').trim();
    const period_id = String((body as any)?.period_id ?? '').trim();
    if (!period_id) {
      return NextResponse.json({ error: 'period_id requis' }, { status: 400 });
    }

    // Auth
    const token = getAccessTokenFromReq(req);
    if (!token) {
      return NextResponse.json({ error: 'Auth session missing!' }, { status: 401 });
    }
    const { data: userData, error: uErr } = await supabase.auth.getUser(token);
    if (uErr || !userData?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const uid = userData.user.id;

    if (action === 'toggle_validate') {
      // On accepte 'month' ou 'month_key'
      const mkRaw = (body as any)?.month ?? (body as any)?.month_key;
      const month = String(mkRaw ?? '').trim();
      const value: boolean = !!(body as any)?.value;

      if (!month || !/^\d{4}-\d{2}$/.test(month)) {
        return NextResponse.json({ error: 'month invalide' }, { status: 400 });
      }

      // Bloquer si locked / opted_out
      const { data: existing, error: exErr } = await supabase
        .from('doctor_period_months')
        .select('locked, opted_out')
        .eq('user_id', uid)
        .eq('period_id', period_id)
        .eq('month', month)
        .maybeSingle();
      if (exErr) return NextResponse.json({ error: exErr.message }, { status: 500 });
      if (existing?.locked) {
        return NextResponse.json(
          { error: 'Mois verrouillé. Déverrouillage requis par un admin.' },
          { status: 409 }
        );
      }
      if (existing?.opted_out) {
        return NextResponse.json(
          { error: 'Mois en opt-out. Désactivez l’opt-out pour modifier la validation.' },
          { status: 409 }
        );
      }

      if (value) {
        const { error: upErr } = await supabase
          .from('doctor_period_months')
          .upsert(
            {
              user_id: uid,
              period_id,
              month,
              validated_at: new Date().toISOString(),
            },
            { onConflict: 'user_id,period_id,month' }
          );
        if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
      } else {
        const { error: updErr } = await supabase
          .from('doctor_period_months')
          .update({ validated_at: null })
          .eq('user_id', uid)
          .eq('period_id', period_id)
          .eq('month', month);
        if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
      }

      // Répondre avec l’état recalculé
      return await GET(new NextRequest(new URL(`${req.url}?period_id=${encodeURIComponent(period_id)}`)));
    }

    if (action === 'opt_out') {
      const value: boolean = !!(body as any)?.value;

      // L’opt-out est “période entière” -> on applique à tous les mois de la période
      const { data: slotRows, error: slotsErr } = await supabase
        .from('slots')
        .select('date')
        .eq('period_id', period_id);
      if (slotsErr) return NextResponse.json({ error: slotsErr.message }, { status: 500 });

      const monthsSet = new Set<string>();
      for (const s of slotRows ?? []) {
        const d = (s as any).date as string | null;
        if (d) monthsSet.add(yyyymm(d));
      }
      const months = Array.from(monthsSet);

      if (months.length === 0) {
        return NextResponse.json({ error: 'Aucun mois pour cette période' }, { status: 400 });
      }

      const rows = months.map(m => ({
        user_id: uid,
        period_id,
        month: m,
        opted_out: value,
        validated_at: value ? new Date().toISOString() : null,
      }));

      // Upsert en lot
      const { error: upErr } = await supabase
        .from('doctor_period_months')
        .upsert(rows, { onConflict: 'user_id,period_id,month' });
      if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

      // Répondre avec l’état recalculé
      return await GET(new NextRequest(new URL(`${req.url}?period_id=${encodeURIComponent(period_id)}`)));
    }

    return NextResponse.json({ error: 'action inconnue' }, { status: 400 });
  } catch (e: any) {
    console.error('[doctor-months POST]', e);
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 });
  }
}
