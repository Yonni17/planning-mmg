// app/api/admin/save-assignments/route.ts
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
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
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
    if (parsed?.currentSession?.access_token) return String(parsed.currentSession.access_token);
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
      errorResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      supabase,
      userId: null as string | null,
    };
  }

  const { data: userData, error: uErr } = await supabase.auth.getUser(token);
  if (uErr || !userData?.user) {
    return {
      errorResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      supabase,
      userId: null,
    };
  }

  const uid = userData.user.id;
  const { data: isAdmin, error: aErr } = await supabase.rpc('is_admin', { uid });
  if (aErr || !isAdmin) {
    return {
      errorResponse: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
      supabase,
      userId: uid,
    };
  }

  return { errorResponse: null as NextResponse | null, supabase, userId: uid };
}

/* -------------------------------- Types --------------------------------- */
type IncomingRow = unknown;
type CleanRow = { slot_id: string; user_id: string; score: number };

function isCleanableRow(x: IncomingRow): x is { slot_id?: unknown; user_id?: unknown; score?: unknown } {
  return typeof x === 'object' && x !== null && ('slot_id' in x) && ('user_id' in x);
}

function toCleanRow(x: IncomingRow): CleanRow | null {
  if (!isCleanableRow(x)) return null;
  const slot_id = String((x as any).slot_id ?? '').trim();
  const user_id = String((x as any).user_id ?? '').trim();
  const scoreRaw = (x as any).score;
  const score = Number.isFinite(Number(scoreRaw)) ? Number(scoreRaw) : 0;
  if (!slot_id || !user_id) return null;
  return { slot_id, user_id, score };
}

/* ------------------------------ Handler --------------------------------- */
export async function POST(req: NextRequest) {
  try {
    const { errorResponse, supabase } = await requireAdminOrResponse(req);
    if (errorResponse) return errorResponse;

    const body = await req.json().catch(() => ({}));
    const period_id = String((body as any)?.period_id ?? '');
    const rowsIn = (body as any)?.rows;

    if (!period_id || !Array.isArray(rowsIn)) {
      return NextResponse.json({ error: 'period_id et rows[] requis' }, { status: 400 });
    }

    // Nettoyage/validation des lignes
    const insertRows: CleanRow[] = [];
    for (const r of rowsIn as IncomingRow[]) {
      const cr = toCleanRow(r);
      if (cr) insertRows.push(cr);
    }
    if (!insertRows.length) {
      return NextResponse.json({ error: 'Aucune ligne valide à insérer' }, { status: 400 });
    }

    // (Optionnel) respect du verrou de la période si activé
    const { data: pa, error: paErr } = await supabase
      .from('period_automation')
      .select('lock_assignments')
      .eq('period_id', period_id)
      .maybeSingle();
    if (paErr) {
      return NextResponse.json({ error: `Lecture verrou: ${paErr.message}` }, { status: 500 });
    }
    if (pa?.lock_assignments === true) {
      return NextResponse.json(
        { error: 'Planning verrouillé (lock_assignments=true). Déverrouillez avant de sauvegarder.' },
        { status: 409 }
      );
    }

    // Purge + insert
    const { error: delErr } = await supabase.from('assignments').delete().eq('period_id', period_id);
    if (delErr) {
      return NextResponse.json({ error: `Suppression échouée: ${delErr.message}` }, { status: 500 });
    }

    const rows = insertRows.map((r) => ({
      period_id,
      slot_id: r.slot_id,
      user_id: r.user_id,
      score: r.score ?? 0,
    }));

    if (rows.length) {
      const { error: insErr } = await supabase.from('assignments').insert(rows);
      if (insErr) {
        return NextResponse.json({ error: `Insertion échouée: ${insErr.message}` }, { status: 500 });
      }
    }

    return NextResponse.json({ ok: true, inserted: rows.length });
  } catch (e: any) {
    console.error('[save-assignments]', e);
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 });
  }
}
