// app/api/admin/tests/route.ts
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
type TestId =
  | 'slots_exist'
  | 'availability_consistency'
  | 'targets_presence'
  | 'assignments_coverage'
  | 'automation_settings'
  | 'doctor_months_status'
  | 'mail_opening'
  | 'mail_weekly_reminder'
  | 'mail_deadline_extra'
  | 'mail_planning_ready';

/* ------------------------------ Handler --------------------------------- */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAdminOrResponse(req);
    if (auth.errorResponse) return auth.errorResponse;
    const supabase = auth.supabase;

    const body = await req.json().catch(() => ({}));
    const test = (body as any)?.test as TestId | undefined;
    const period_id = ((body as any)?.period_id as string | undefined) ?? null;

    if (!test) return NextResponse.json({ error: 'test requis' }, { status: 400 });

    const getSlots = async () => {
      if (!period_id) return [];
      const { data, error } = await supabase
        .from('slots')
        .select('id, date, kind')
        .eq('period_id', period_id)
        .order('date', { ascending: true });
      if (error) throw error;
      return data ?? [];
    };

    // ---------- automation_settings (global) ----------
    if (test === 'automation_settings') {
      const { data, error } = await supabase
        .from('automation_settings')
        .select('key, updated_at, settings')
        .eq('key', 'global')
        .maybeSingle();
      if (error) throw error;
      const ok = !!data;
      return NextResponse.json({
        ok,
        title: 'Réglages d’automatisation (globaux)',
        details: data ?? { message: 'Aucun réglage global en base — l’API utilisera ses defaults.' },
      });
    }

    // ---- Tout le reste requiert une période ----
    if (!period_id) {
      return NextResponse.json({ error: 'period_id requis pour ce test' }, { status: 400 });
    }

    // ---------- slots_exist ----------
    if (test === 'slots_exist') {
      const slots = await getSlots();
      const ok = slots.length > 0;
      return NextResponse.json({
        ok,
        title: 'Slots présents pour la période',
        details: { total_slots: slots.length, sample: slots.slice(0, 5) },
      });
    }

    // ---------- availability_consistency ----------
    if (test === 'availability_consistency') {
      const slots = await getSlots();
      const slotIds = slots.map((s: any) => s.id);
      if (slotIds.length === 0) {
        return NextResponse.json({
          ok: false,
          title: 'Disponibilités',
          details: { message: 'Aucun slot pour cette période' },
        });
      }
      const { data, error } = await supabase
        .from('availability')
        .select('slot_id, user_id, available')
        .in('slot_id', slotIds);
      if (error) throw error;

      const mapCount: Record<string, number> = {};
      const users = new Set<string>();
      for (const row of data ?? []) {
        if (row.available) {
          mapCount[row.slot_id] = (mapCount[row.slot_id] ?? 0) + 1;
          users.add(row.user_id);
        }
      }
      const counts = Object.values(mapCount);
      const min = counts.length ? Math.min(...counts) : 0;
      const max = counts.length ? Math.max(...counts) : 0;
      return NextResponse.json({
        ok: counts.length > 0,
        title: 'Disponibilités (cohérence & volume)',
        details: {
          slots_with_any_candidate: counts.length,
          distinct_users_available: users.size,
          min_candidates_per_slot: min,
          max_candidates_per_slot: max,
          sample: Object.entries(mapCount).slice(0, 5),
        },
      });
    }

    // ---------- targets_presence ----------
    if (test === 'targets_presence') {
      const slots = await getSlots();
      const slotIds = slots.map((s: any) => s.id);
      if (slotIds.length === 0) {
        return NextResponse.json({
          ok: false,
          title: 'Cibles',
          details: { message: 'Aucun slot pour cette période' },
        });
      }
      const { data: av, error: avErr } = await supabase
        .from('availability')
        .select('user_id, available')
        .in('slot_id', slotIds);
      if (avErr) throw avErr;

      const users = new Set<string>();
      for (const r of av ?? []) if (r.available) users.add(r.user_id);

      const { data: prefs, error: prErr } = await supabase
        .from('preferences_period')
        .select('user_id, target_level')
        .eq('period_id', period_id);
      if (prErr) throw prErr;

      const withPref = new Set((prefs ?? []).map((p) => p.user_id));
      let missing = 0;
      for (const u of users) if (!withPref.has(u)) missing++;

      return NextResponse.json({
        ok: missing === 0,
        title: 'Cibles (preferences_period)',
        details: {
          users_with_availability: users.size,
          users_with_target_level: withPref.size,
          missing_target_for_users: missing,
        },
      });
    }

    // ---------- assignments_coverage ----------
    if (test === 'assignments_coverage') {
      const slots = await getSlots();
      const slotIds = slots.map((s: any) => s.id);
      if (slotIds.length === 0) {
        return NextResponse.json({
          ok: false,
          title: 'Assignations',
          details: { message: 'Aucun slot pour cette période' },
        });
      }
      const { data: asg, error: asgErr } = await supabase
        .from('assignments')
        .select('slot_id, user_id')
        .eq('period_id', period_id);
      if (asgErr) throw asgErr;

      const bySlot: Record<string, number> = {};
      for (const a of asg ?? []) {
        bySlot[a.slot_id] = (bySlot[a.slot_id] ?? 0) + 1;
      }
      let holes = 0,
        multi = 0;
      for (const sid of slotIds) {
        const c = bySlot[sid] ?? 0;
        if (c === 0) holes++;
        if (c > 1) multi++;
      }
      const ok = holes === 0 && multi === 0;
      return NextResponse.json({
        ok,
        title: 'Assignations (couverture)',
        details: {
          total_slots: slotIds.length,
          assigned_rows: (asg ?? []).length,
          holes,
          multi_assignments: multi,
        },
      });
    }

    // ---------- doctor_months_status ----------
    if (test === 'doctor_months_status') {
      const { data, error } = await supabase
        .from('doctor_period_months')
        .select('period_id, month, locked, opted_out');
      if (error) throw error;

      const total = data?.length ?? 0;
      const byMonth: Record<string, { total: number; locked: number; opted_out: number }> = {};
      for (const r of data ?? []) {
        const m = r.month as string;
        byMonth[m] = byMonth[m] || { total: 0, locked: 0, opted_out: 0 };
        byMonth[m].total++;
        if (r.locked) byMonth[m].locked++;
        if (r.opted_out) byMonth[m].opted_out++;
      }
      return NextResponse.json({
        ok: total > 0,
        title: 'Statut des mois (doctor_period_months)',
        details: { rows: total, byMonth },
      });
    }

    // ====================================================================
    //                       TESTS ALERTES EMAIL (dry-run)
    // ====================================================================
    async function loadPeriodAuto() {
      const { data } = await supabase
        .from('period_automation')
        .select('avail_open_at, avail_deadline, weekly_reminder, extra_reminder_hours')
        .eq('period_id', period_id)
        .maybeSingle();
      return {
        avail_open_at: data?.avail_open_at ? new Date(data.avail_open_at) : null,
        avail_deadline: data?.avail_deadline ? new Date(data.avail_deadline) : null,
        weekly_reminder: data?.weekly_reminder ?? true,
        extra_reminder_hours: Array.isArray(data?.extra_reminder_hours)
          ? (data!.extra_reminder_hours as number[])
          : [48, 24, 1],
      };
    }

    async function doctorsUserIds(): Promise<string[]> {
      const { data, error } = await supabase
        .from('profiles')
        .select('user_id, role')
        .eq('role', 'doctor');
      if (error) throw error;
      return (data ?? []).map((r) => r.user_id);
    }

    async function notLockedNotOptedOut(): Promise<Record<string, string[]>> {
      // map month -> user_ids concernés
      const { data, error } = await supabase
        .from('doctor_period_months')
        .select('user_id, month, locked, opted_out')
        .eq('period_id', period_id);
      if (error) throw error;
      const byMonth: Record<string, string[]> = {};
      for (const r of data ?? []) {
        if (!r.locked && !r.opted_out) {
          (byMonth[r.month] ||= []).push(r.user_id);
        }
      }
      return byMonth;
    }

    if (test === 'mail_opening') {
      const now = new Date();
      const auto = await loadPeriodAuto();
      await doctorsUserIds(); // charge pour compter
      const byMonth = await notLockedNotOptedOut();

      // destinataires = docteurs avec au moins 1 mois non verrouillé et non opt-out
      const recipients = new Set<string>();
      Object.values(byMonth).forEach((arr) => arr.forEach((u) => recipients.add(u)));

      const should_trigger_now =
        !!auto.avail_open_at &&
        now >= auto.avail_open_at &&
        (!!auto.avail_deadline ? now < auto.avail_deadline : true);

      return NextResponse.json({
        ok: recipients.size > 0,
        title: 'Mail — Ouverture des disponibilités',
        details: {
          should_trigger_now,
          avail_open_at: auto.avail_open_at,
          avail_deadline: auto.avail_deadline,
          recipients_count: recipients.size,
          sample_recipients: Array.from(recipients).slice(0, 10),
        },
      });
    }

    if (test === 'mail_weekly_reminder') {
      const now = new Date();
      const auto = await loadPeriodAuto();
      const byMonth = await notLockedNotOptedOut();

      // Rappel hebdo uniquement entre ouverture et deadline
      const window_ok =
        !!auto.avail_open_at &&
        now >= auto.avail_open_at &&
        (!!auto.avail_deadline ? now < auto.avail_deadline : true);

      const recipients = new Set<string>();
      Object.values(byMonth).forEach((arr) => arr.forEach((u) => recipients.add(u)));

      return NextResponse.json({
        ok: window_ok && auto.weekly_reminder && recipients.size > 0,
        title: 'Mail — Rappel hebdomadaire',
        details: {
          window_ok,
          weekly_reminder_enabled: auto.weekly_reminder,
          recipients_count: recipients.size,
          sample_recipients: Array.from(recipients).slice(0, 10),
        },
      });
    }

    if (test === 'mail_deadline_extra') {
      const now = new Date();
      const auto = await loadPeriodAuto();
      const byMonth = await notLockedNotOptedOut();

      const recipients = new Set<string>();
      Object.values(byMonth).forEach((arr) => arr.forEach((u) => recipients.add(u)));

      let hoursBefore: number | null = null;
      let should_trigger_now = false;
      if (auto.avail_deadline) {
        const ms = auto.avail_deadline.getTime() - now.getTime();
        const h = Math.floor(ms / 3_600_000);
        hoursBefore = h;
        // si on est exactement sur l’une des valeurs (48, 24, 1)
        should_trigger_now = (auto.extra_reminder_hours || [48, 24, 1]).includes(h);
      }

      return NextResponse.json({
        ok: hoursBefore !== null && recipients.size > 0,
        title: 'Mail — Rappels supplémentaires (48/24/1h)',
        details: {
          avail_deadline: auto.avail_deadline,
          now,
          hours_before_deadline: hoursBefore,
          configured_hours: auto.extra_reminder_hours,
          should_trigger_now,
          recipients_count: recipients.size,
          sample_recipients: Array.from(recipients).slice(0, 10),
        },
      });
    }

    if (test === 'mail_planning_ready') {
      // destinataires = docteurs qui ont au moins une assignation dans la période
      const { data: asg, error } = await supabase
        .from('assignments')
        .select('user_id')
        .eq('period_id', period_id);
      if (error) throw error;
      const recipients = new Set<string>((asg ?? []).map((r) => r.user_id));
      return NextResponse.json({
        ok: recipients.size > 0,
        title: 'Mail — Planning validé & prêt',
        details: {
          recipients_count: recipients.size,
          sample_recipients: Array.from(recipients).slice(0, 10),
        },
      });
    }

    return NextResponse.json({ error: 'Test inconnu' }, { status: 400 });
  } catch (e: any) {
    console.error('[admin/tests]', e);
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 });
  }
}
