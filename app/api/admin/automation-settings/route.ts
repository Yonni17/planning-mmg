// app/api/admin/automation-settings/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Récupère l'access token depuis Authorization: Bearer ou cookies Supabase */
function getAccessTokenFromReq(req: NextRequest): string | null {
  // 1) Authorization: Bearer <jwt>
  const auth = req.headers.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

  // 2) Cookie direct sb-access-token (supabase-js v2 côté client)
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

/** Vérifie l’admin via RPC is_admin(uid) */
async function requireAdminOrResponse(req: NextRequest) {
  const supabase = getSupabaseAdmin();

  const token = getAccessTokenFromReq(req);
  if (!token) {
    return {
      errorResponse: NextResponse.json(
        { ok: false, error: 'Unauthorized' },
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
        { ok: false, error: 'Unauthorized' },
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
        { ok: false, error: 'Forbidden' },
        { status: 403 }
      ),
      supabase,
      userId: uid,
    };
  }

  return { errorResponse: null as NextResponse | null, supabase, userId: uid };
}

/** GET : lit/retourne les réglages de la période (ou des defaults s’il n’y a pas encore de ligne) */
export async function GET(req: NextRequest) {
  const { errorResponse, supabase } = await requireAdminOrResponse(req);
  if (errorResponse) return errorResponse;

  const { searchParams } = new URL(req.url);
  const period_id = searchParams.get('period_id');
  if (!period_id) {
    return NextResponse.json(
      { error: 'period_id requis' },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from('period_automation')
    .select('*')
    .eq('period_id', period_id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // valeurs par défaut si pas de ligne pour cette période
  const defaults = {
    period_id,
    slots_generate_before_days: 45,
    avail_open_at: null as string | null,
    avail_deadline: null as string | null,
    weekly_reminder: true,
    extra_reminder_hours: [48, 24, 1] as number[],
    planning_generate_before_days: 21,
    lock_assignments: false,
  };

  return NextResponse.json(data ?? defaults);
}

/** POST : upsert des réglages pour une période */
export async function POST(req: NextRequest) {
  const { errorResponse, supabase } = await requireAdminOrResponse(req);
  if (errorResponse) return errorResponse;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const payload = body as Record<string, unknown>;
  const period_id = String(payload.period_id ?? '');
  if (!period_id) {
    return NextResponse.json(
      { error: 'period_id requis' },
      { status: 400 }
    );
  }

  // coercitions douces
  const toNum = (v: unknown) =>
    typeof v === 'number'
      ? v
      : Number.isFinite(Number(v))
      ? Number(v)
      : undefined;

  let extraHours: number[] | undefined;
  const erh = payload.extra_reminder_hours;
  if (Array.isArray(erh)) {
    extraHours = (erh as unknown[]).map(toNum).filter((n): n is number => Number.isFinite(n as number));
  } else if (typeof erh === 'string') {
    extraHours = (erh as string)
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
  }

  const row: Record<string, unknown> = {
    period_id,
  };

  const sgbd = toNum(payload.slots_generate_before_days);
  if (typeof sgbd === 'number') row.slots_generate_before_days = sgbd;

  if (payload.avail_open_at) {
    const d = new Date(String(payload.avail_open_at));
    row.avail_open_at = isNaN(d.valueOf()) ? null : d.toISOString();
  } else {
    row.avail_open_at = null;
  }

  if (payload.avail_deadline) {
    const d = new Date(String(payload.avail_deadline));
    row.avail_deadline = isNaN(d.valueOf()) ? null : d.toISOString();
  } else {
    row.avail_deadline = null;
  }

  if (typeof payload.weekly_reminder === 'boolean') {
    row.weekly_reminder = payload.weekly_reminder;
  }

  if (extraHours && extraHours.length) {
    row.extra_reminder_hours = extraHours;
  }

  const pgbd = toNum(payload.planning_generate_before_days);
  if (typeof pgbd === 'number') row.planning_generate_before_days = pgbd;

  if (typeof payload.lock_assignments === 'boolean') {
    row.lock_assignments = payload.lock_assignments;
  }

  const { data, error } = await supabase
    .from('period_automation')
    .upsert(row, { onConflict: 'period_id' })
    .select('*')
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data);
}
