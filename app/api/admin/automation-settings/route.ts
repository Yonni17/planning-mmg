// app/api/admin/automation-settings/route.ts
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
  const c  = store.get(base)?.value ?? '';
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

async function requireAdmin(req: NextRequest) {
  const authHeader = req.headers.get('authorization') || '';
  let access_token: string | null = null;
  if (authHeader.toLowerCase().startsWith('bearer ')) access_token = authHeader.slice(7).trim();
  if (!access_token) access_token = await getAccessTokenFromCookies();
  if (!access_token) return { error: 'Auth session missing!' };

  const { data: userData, error: userErr } = await supabaseAnon.auth.getUser(access_token);
  if (userErr || !userData.user) return { error: 'Unauthorized' };

  const { data: isAdmin, error: adminErr } = await supabaseService.rpc('is_admin', { uid: userData.user.id });
  if (adminErr) return { error: adminErr.message };
  if (!isAdmin) return { error: 'Forbidden' };
  return { user: userData.user };
}

/** GET : lit/retourne les réglages de la période (ou des defaults s’il n’y a pas encore de ligne) */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const period_id = searchParams.get('period_id');
  if (!period_id) return NextResponse.json({ error: 'period_id requis' }, { status: 400 });

  const { data, error } = await supabaseService
    .from('period_automation')
    .select('*')
    .eq('period_id', period_id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // valeurs par défaut si pas de ligne pour cette période
  const defaults = {
    period_id,
    slots_generate_before_days: 45,
    avail_open_at: null,
    avail_deadline: null,
    weekly_reminder: true,
    extra_reminder_hours: [48, 24, 1],
    planning_generate_before_days: 21,
    lock_assignments: false,
  };

  return NextResponse.json(data ?? defaults);
}

/** POST : upsert des réglages pour une période */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: 401 });

  const body = await req.json();
  const {
    period_id,
    slots_generate_before_days,
    avail_open_at,
    avail_deadline,
    weekly_reminder,
    extra_reminder_hours, // string "48,24,1" ou array
    planning_generate_before_days,
    lock_assignments,
  } = body ?? {};

  if (!period_id) return NextResponse.json({ error: 'period_id requis' }, { status: 400 });

  let extraHours: number[] | null = null;
  if (Array.isArray(extra_reminder_hours)) {
    extraHours = extra_reminder_hours.map((n: any) => Number(n)).filter((n: any) => Number.isFinite(n));
  } else if (typeof extra_reminder_hours === 'string') {
    extraHours = extra_reminder_hours
      .split(',')
      .map(s => Number(s.trim()))
      .filter(n => Number.isFinite(n));
  }

  const row = {
    period_id,
    ...(Number.isFinite(Number(slots_generate_before_days)) ? { slots_generate_before_days: Number(slots_generate_before_days) } : {}),
    ...(avail_open_at ? { avail_open_at: new Date(avail_open_at).toISOString() } : { avail_open_at: null }),
    ...(avail_deadline ? { avail_deadline: new Date(avail_deadline).toISOString() } : { avail_deadline: null }),
    ...(typeof weekly_reminder === 'boolean' ? { weekly_reminder } : {}),
    ...(extraHours ? { extra_reminder_hours: extraHours } : {}),
    ...(Number.isFinite(Number(planning_generate_before_days)) ? { planning_generate_before_days: Number(planning_generate_before_days) } : {}),
    ...(typeof lock_assignments === 'boolean' ? { lock_assignments } : {}),
  };

  const { data, error } = await supabaseService
    .from('period_automation')
    .upsert(row, { onConflict: 'period_id' })
    .select('*')
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
