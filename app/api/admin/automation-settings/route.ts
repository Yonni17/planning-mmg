import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* -------- Auth helpers (Bearer ou cookies Supabase) -------- */
function getAccessTokenFromReq(req: NextRequest): string | null {
  const auth = req.headers.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const c = cookies();
  const direct = c.get('sb-access-token')?.value;
  if (direct) return direct;

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
  } catch {}
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

/* ---------------- Utils ---------------- */
const asInt = (v: any, def: number) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? Math.max(0, n) : def;
};
const nowIso = () => new Date().toISOString();

/* ---------------- GET ---------------- */
export async function GET(req: NextRequest) {
  const auth = await requireAdminOrResponse(req);
  if (auth.errorResponse) return auth.errorResponse;
  const supabase = auth.supabase;

  try {
    const pid = req.nextUrl.searchParams.get('period_id') || null;

    const { data: periods, error: pErr } = await supabase
      .from('periods')
      .select('id,label,open_at,close_at,generate_at,timezone')
      .order('open_at', { ascending: false });
    if (pErr) throw pErr;

    if (!pid) {
      return NextResponse.json({ periods });
    }

    const { data: row, error: rErr } = await supabase
      .from('period_automation')
      .select('period_id, slots_generate_before_days, avail_deadline_before_days, planning_generate_before_days, weekly_reminder, extra_reminder_hours, lock_assignments, avail_open_at, avail_deadline, updated_at')
      .eq('period_id', pid)
      .maybeSingle();
    if (rErr) throw rErr;

    const defaults = {
      period_id: pid,
      slots_generate_before_days: 45,
      avail_deadline_before_days: 15,
      planning_generate_before_days: 21,
      weekly_reminder: true,
      extra_reminder_hours: [48, 24, 1],
      lock_assignments: false,
      avail_open_at: null,
      avail_deadline: null,
      updated_at: null,
    };

    return NextResponse.json({ periods, row: row ?? defaults });
  } catch (e: any) {
    console.error('[admin/automation-settings GET]', e);
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 });
  }
}

/* ---------------- POST (upsert) ---------------- */
export async function POST(req: NextRequest) {
  const auth = await requireAdminOrResponse(req);
  if (auth.errorResponse) return auth.errorResponse;
  const supabase = auth.supabase;

  try {
    const body = await req.json().catch(() => ({}));
    const period_id = String((body as any)?.period_id || '');

    if (!period_id) {
      return NextResponse.json({ error: 'period_id requis' }, { status: 400 });
    }

    const slots_generate_before_days = asInt((body as any)?.slots_generate_before_days, 45);
    const avail_deadline_before_days = asInt((body as any)?.avail_deadline_before_days, 15);
    const planning_generate_before_days = asInt((body as any)?.planning_generate_before_days, 21);

    const weekly_reminder = !!(body as any)?.weekly_reminder;
    const extra_reminder_hours = Array.isArray((body as any)?.extra_reminder_hours)
      ? (body as any)?.extra_reminder_hours
          .map((n: any) => Number.parseInt(String(n), 10))
          .filter((n: any) => Number.isFinite(n))
      : [48, 24, 1];

    const lock_assignments = !!(body as any)?.lock_assignments;

    // récupérer la période (open_at)
    const { data: p, error: pErr } = await supabase
      .from('periods')
      .select('id, open_at')
      .eq('id', period_id)
      .maybeSingle();
    if (pErr || !p) {
      return NextResponse.json({ error: 'Période introuvable' }, { status: 404 });
    }

    // calculs à partir de J-x
    const start = new Date(p.open_at);
    const minusDays = (days: number) =>
      new Date(start.getTime() - days * 24 * 3600 * 1000).toISOString();

    const computed_avail_open_at = minusDays(slots_generate_before_days);
    const computed_avail_deadline = minusDays(avail_deadline_before_days);
    const computed_generate_at = minusDays(planning_generate_before_days);

    // upsert period_automation
    const payload = {
      period_id,
      slots_generate_before_days,
      avail_deadline_before_days,
      planning_generate_before_days,
      weekly_reminder,
      extra_reminder_hours,
      lock_assignments,
      avail_open_at: computed_avail_open_at,
      avail_deadline: computed_avail_deadline,
      updated_at: nowIso(),
    };

    const { error: upErr } = await supabase
      .from('period_automation')
      .upsert(payload as any, { onConflict: 'period_id' })
      .eq('period_id', period_id);
    if (upErr) throw upErr;

    // MAJ periods.generate_at pour le compte à rebours côté app
    const { error: updPer } = await supabase
      .from('periods')
      .update({ generate_at: computed_generate_at } as any)
      .eq('id', period_id);
    if (updPer) throw updPer;

    // renvoi
    const { data: row } = await supabase
      .from('period_automation')
      .select('period_id, slots_generate_before_days, avail_deadline_before_days, planning_generate_before_days, weekly_reminder, extra_reminder_hours, lock_assignments, avail_open_at, avail_deadline, updated_at')
      .eq('period_id', period_id)
      .maybeSingle();

    return NextResponse.json({ ok: true, row });
  } catch (e: any) {
    console.error('[admin/automation-settings POST]', e);
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 });
  }
}
