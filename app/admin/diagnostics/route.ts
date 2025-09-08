// app/api/admin/diagnostics/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SRK  = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function bad(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

async function requireAdmin(req: NextRequest) {
  const authHeader = req.headers.get('authorization') || '';
  const anon = createClient(URL, ANON, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: u } = await anon.auth.getUser();
  if (!u?.user) return { ok: false as const, error: 'Unauthenticated' };

  const svc = createClient(URL, SRK, { auth: { persistSession: false } });
  const { data: prof } = await svc.from('profiles').select('role').eq('user_id', u.user.id).maybeSingle();
  if (!prof || prof.role !== 'admin') return { ok: false as const, error: 'Forbidden' };
  return { ok: true as const };
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return bad(401, auth.error);

  const { period_id, nowISO, limit = 50 } = await req.json();
  if (!period_id) return bad(400, 'period_id required');

  const now = nowISO ? new Date(nowISO) : new Date();

  const svc = createClient(URL, SRK, { auth: { persistSession: false } });

  // Réglages effectifs
  const { data: eff, error: effErr } = await svc
    .from('v_effective_automation')
    .select('period_id,label,avail_open_at_effective,avail_deadline_effective,weekly_reminder_effective,extra_reminder_hours_effective,planning_generate_before_days_effective,tz_effective')
    .eq('period_id', period_id)
    .maybeSingle();
  if (effErr || !eff) return bad(404, 'period not found in v_effective_automation');

  const openAt   = eff.avail_open_at_effective ? new Date(eff.avail_open_at_effective) : null;
  const deadline = eff.avail_deadline_effective ? new Date(eff.avail_deadline_effective) : null;
  const inWindow = !!(openAt && deadline && now >= openAt && now < deadline);
  const hoursLeft = deadline ? (deadline.getTime() - now.getTime()) / 36e5 : null;

  const due: Array<'weekly'|'deadline_48'|'deadline_24'|'deadline_1'> = [];
  if (inWindow && deadline) {
    const tol = 0.25; // 15 min de tolérance
    const h48 = Math.abs((hoursLeft ?? 0) - 48) <= tol && eff.extra_reminder_hours_effective?.includes(48);
    const h24 = Math.abs((hoursLeft ?? 0) - 24) <= tol && eff.extra_reminder_hours_effective?.includes(24);
    const h1  = Math.abs((hoursLeft ?? 0) - 1)  <= tol && eff.extra_reminder_hours_effective?.includes(1);
    if (h48) due.push('deadline_48');
    if (h24) due.push('deadline_24');
    if (h1)  due.push('deadline_1');

    if (eff.weekly_reminder_effective) {
      // Hebdo (exemple simple: lundi 09:00 Europe/Paris)
      const parisNow = new Date(now.toLocaleString('en-US', { timeZone: eff.tz_effective || 'Europe/Paris' }));
      const isMonday = parisNow.getDay() === 1;
      const isNine   = parisNow.getHours() === 9;
      if (isMonday && isNine) due.push('weekly');
    }
  }

  // Cibles (non verrouillés / non validés / pas opt-out)
  const { data: targets, error: tErr } = await svc
    .from('v_reminder_targets')
    .select('user_id')
    .eq('period_id', period_id);
  if (tErr) return bad(500, tErr.message);

  const ids = (targets || []).map(t => t.user_id);
  const { data: profs } = await svc
    .from('profiles')
    .select('user_id, email, full_name')
    .in('user_id', ids)
    .limit(limit);

  // Compteurs divers
  const [{ data: slotsCount }] = await Promise.all([
    svc.from('slots').select('id', { count: 'exact', head: true }).eq('period_id', period_id),
  ]);

  // Décomposition flags doctor_period_flags
  const { data: flags } = await svc
    .from('doctor_period_flags')
    .select('locked, all_validated, opted_out')
    .eq('period_id', period_id);

  const counts = {
    slots: slotsCount?.length ? slotsCount.length : (slotsCount as any) || undefined, // head:true renvoie count dans supabase-js v2: use data: null, count in response
    doctors: ids.length || 0,
    targets: ids.length || 0,
    locked: flags?.filter(f => f.locked)?.length || 0,
    validated: flags?.filter(f => f.all_validated)?.length || 0,
    opted_out: flags?.filter(f => f.opted_out)?.length || 0,
  };

  return NextResponse.json({
    ok: true,
    period_id,
    period_label: eff.label ?? undefined,
    effective: {
      avail_open_at: eff.avail_open_at_effective,
      avail_deadline: eff.avail_deadline_effective,
      weekly_reminder: !!eff.weekly_reminder_effective,
      extra_reminder_hours: eff.extra_reminder_hours_effective || [],
      planning_generate_before_days: eff.planning_generate_before_days_effective ?? 21,
      tz: eff.tz_effective || 'Europe/Paris',
      in_window: inWindow,
      hours_left: hoursLeft,
      now: now.toISOString(),
      due_kinds: due,
    },
    counts,
    targets_preview: (profs || []).map(p => ({
      user_id: p.user_id,
      email: p.email,
      full_name: p.full_name,
    })),
  });
}
