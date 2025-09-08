export const dynamic = 'force-dynamic';
export const revalidate = 0;
'use client';
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';


// ==== ENV ====
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// ==== Utils ====
function bad(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

// Récupère l'utilisateur via le Bearer + vérifie role=admin
async function requireAdmin(req: NextRequest) {
  const authHeader = req.headers.get('authorization') || req.headers.get('Authorization') || '';
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: u, error: ue } = await anon.auth.getUser();
  if (ue || !u?.user) return { ok: false as const, error: 'Unauthenticated' };

  // Vérifie profil admin
  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: prof, error: pe } = await service
    .from('profiles')
    .select('role')
    .eq('user_id', u.user.id)
    .maybeSingle();

  if (pe) return { ok: false as const, error: `Profile error: ${pe.message}` };
  if (!prof || prof.role !== 'admin') return { ok: false as const, error: 'Forbidden (admin only)' };

  return { ok: true as const, user: u.user };
}

// Defaults (si global/période manquants)
const DEFAULTS = {
  tz: 'Europe/Paris',
  weekly_reminder: true,
  extra_reminder_hours: [48, 24, 1] as number[],
  planning_generate_before_days: 21,
  lock_assignments: false,
  slots_generate_before_days: 45,
  avail_deadline_before_days: 15,
};

// Merge JSON global + defaults
function computeGlobalEffective(globalSettings: any) {
  const s = globalSettings ?? {};
  return {
    tz: s.tz ?? DEFAULTS.tz,
    weekly_reminder: coalesceBool(s.weekly_reminder, DEFAULTS.weekly_reminder),
    extra_reminder_hours: normalizeIntArray(s.extra_reminder_hours, DEFAULTS.extra_reminder_hours),
    planning_generate_before_days:
      toInt(s.planning_generate_before_days, DEFAULTS.planning_generate_before_days),
    lock_assignments: coalesceBool(s.lock_assignments, DEFAULTS.lock_assignments),
    slots_generate_before_days:
      toInt(s.slots_generate_before_days, DEFAULTS.slots_generate_before_days),
    avail_deadline_before_days:
      toInt(s.avail_deadline_before_days, DEFAULTS.avail_deadline_before_days),
  };
}

function toInt(v: any, d: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function coalesceBool(v: any, d: boolean) {
  return typeof v === 'boolean' ? v : d;
}
function normalizeIntArray(v: any, d: number[]) {
  if (Array.isArray(v)) {
    const arr = v.map((x) => Number(x)).filter((x) => Number.isFinite(x));
    if (arr.length) return arr;
    return [];
  }
  return d;
}

// ==== GET ====
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return bad(401, admin.error);

  const periodId = req.nextUrl.searchParams.get('period_id');
  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // 1) Récupère global
  const { data: globalRow, error: ge } = await service
    .from('automation_settings')
    .select('settings')
    .eq('key', 'global')
    .maybeSingle();

  const globalSettings = globalRow?.settings ?? null;
  const globalEffective = computeGlobalEffective(globalSettings);

  // 2) Si period_id fourni ⇒ récupère period_automation + vue effective
  if (periodId) {
    const { data: pa, error: pae } = await service
      .from('period_automation')
      .select(
        'period_id, avail_open_at, avail_deadline, weekly_reminder, extra_reminder_hours, planning_generate_before_days, lock_assignments, slots_generate_before_days, avail_deadline_before_days'
      )
      .eq('period_id', periodId)
      .maybeSingle();

    if (pae) return bad(500, pae.message);

    // Vue effective (si elle existe, on la lit, sinon on calcule un fallback à partir de periods + overrides)
    const { data: eff, error: ee } = await service
      .from('v_effective_automation')
      .select(
        'period_id, avail_open_at_effective, avail_deadline_effective, weekly_reminder_effective, extra_reminder_hours_effective, planning_generate_before_days_effective, lock_assignments_effective, tz_effective'
      )
      .eq('period_id', periodId)
      .maybeSingle();

    if (ee) return bad(500, ee.message);

    // Si la vue n’existe pas chez toi, tu peux fallback (mais tu as déjà créé la vue à l’étape 3 normalement)
    if (!eff) {
      // Fallback simple : prend periods + overrides + global
      const { data: p, error: pe } = await service
        .from('periods')
        .select('open_at, close_at, timezone')
        .eq('id', periodId)
        .maybeSingle();
      if (pe) return bad(500, pe.message);

      const effective = {
        avail_open_at: pa?.avail_open_at ?? p?.open_at ?? null,
        avail_deadline:
          pa?.avail_deadline ??
          p?.close_at ??
          null, // (on pourrait utiliser avail_deadline_before_days si besoin)
        weekly_reminder: pa?.weekly_reminder ?? globalEffective.weekly_reminder,
        extra_reminder_hours: pa?.extra_reminder_hours ?? globalEffective.extra_reminder_hours,
        planning_generate_before_days:
          pa?.planning_generate_before_days ?? globalEffective.planning_generate_before_days,
        lock_assignments: pa?.lock_assignments ?? globalEffective.lock_assignments,
        tz: p?.timezone ?? globalEffective.tz,
      };

      return NextResponse.json({
        scope: 'period',
        period_id: periodId,
        effective,
        raw: pa ?? null,
        global: globalEffective,
      });
    }

    // Réponse standard avec la vue
    return NextResponse.json({
      scope: 'period',
      period_id: periodId,
      effective: {
        avail_open_at: eff.avail_open_at_effective,
        avail_deadline: eff.avail_deadline_effective,
        weekly_reminder: eff.weekly_reminder_effective,
        extra_reminder_hours: eff.extra_reminder_hours_effective,
        planning_generate_before_days: eff.planning_generate_before_days_effective,
        lock_assignments: eff.lock_assignments_effective,
        tz: eff.tz_effective,
      },
      raw: pa ?? null,
      global: globalEffective,
    });
  }

  // 3) Sinon ⇒ portée globale uniquement
  return NextResponse.json({
    scope: 'global',
    period_id: null,
    effective: {
      // Pas d’open/deadline “effectives” sans période, on expose les paramètres globaux seulement
      weekly_reminder: globalEffective.weekly_reminder,
      extra_reminder_hours: globalEffective.extra_reminder_hours,
      planning_generate_before_days: globalEffective.planning_generate_before_days,
      lock_assignments: globalEffective.lock_assignments,
      tz: globalEffective.tz,
    },
    raw: globalRow ?? null,
  });
}

// ==== POST ====
// Body attendu = { period_id: string|null, avail_open_at?: string|null, avail_deadline?: string|null,
//                  weekly_reminder?: boolean, extra_reminder_hours?: number[],
//                  planning_generate_before_days?: number, lock_assignments?: boolean,
//                  slots_generate_before_days?: number, avail_deadline_before_days?: number }
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return bad(401, admin.error);

  const body = await req.json();

  // Normalisation de l’array
  const extra_hours = Array.isArray(body.extra_reminder_hours)
    ? body.extra_reminder_hours.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n))
    : null;

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // A) portée globale
  if (!body.period_id) {
    const settings = {
      tz: typeof body.tz === 'string' ? body.tz : undefined,
      weekly_reminder:
        typeof body.weekly_reminder === 'boolean' ? body.weekly_reminder : undefined,
      extra_reminder_hours: extra_hours ?? undefined,
      planning_generate_before_days: isFiniteNum(body.planning_generate_before_days)
        ? Number(body.planning_generate_before_days)
        : undefined,
      lock_assignments:
        typeof body.lock_assignments === 'boolean' ? body.lock_assignments : undefined,
      slots_generate_before_days: isFiniteNum(body.slots_generate_before_days)
        ? Number(body.slots_generate_before_days)
        : undefined,
      avail_deadline_before_days: isFiniteNum(body.avail_deadline_before_days)
        ? Number(body.avail_deadline_before_days)
        : undefined,
    };

    // On enlève les undefined pour avoir un JSON propre
    const cleaned: Record<string, any> = {};
    for (const [k, v] of Object.entries(settings)) {
      if (v !== undefined) cleaned[k] = v;
    }

    // Merge sur l’existant (pour ne pas effacer des clés non envoyées)
    const { data: current, error: ce } = await service
      .from('automation_settings')
      .select('settings')
      .eq('key', 'global')
      .maybeSingle();

    const merged = { ...(current?.settings ?? {}), ...cleaned };

    const { error: upErr } = await service
      .from('automation_settings')
      .upsert({ key: 'global', settings: merged }, { onConflict: 'key' });

    if (upErr) return bad(500, upErr.message);

    return NextResponse.json(merged);
  }

  // B) portée période (upsert period_automation)
  const payload: any = {
    period_id: body.period_id,
    // null = on enlève l’override (hérite du global via la vue)
    avail_open_at: body.avail_open_at ?? null,
    avail_deadline: body.avail_deadline ?? null,
    weekly_reminder:
      typeof body.weekly_reminder === 'boolean' ? body.weekly_reminder : null,
    extra_reminder_hours: Array.isArray(extra_hours) ? extra_hours : null,
    planning_generate_before_days: isFiniteNum(body.planning_generate_before_days)
      ? Number(body.planning_generate_before_days)
      : null,
    lock_assignments:
      typeof body.lock_assignments === 'boolean' ? body.lock_assignments : null,
    slots_generate_before_days: isFiniteNum(body.slots_generate_before_days)
      ? Number(body.slots_generate_before_days)
      : null,
    avail_deadline_before_days: isFiniteNum(body.avail_deadline_before_days)
      ? Number(body.avail_deadline_before_days)
      : null,
    updated_at: new Date().toISOString(),
  };

  const { error: pe } = await service
    .from('period_automation')
    .upsert(payload, { onConflict: 'period_id' });

  if (pe) return bad(500, pe.message);

  // Renvoie la ligne stockée
  const { data: saved, error: re } = await service
    .from('period_automation')
    .select(
      'period_id, avail_open_at, avail_deadline, weekly_reminder, extra_reminder_hours, planning_generate_before_days, lock_assignments, slots_generate_before_days, avail_deadline_before_days, updated_at'
    )
    .eq('period_id', body.period_id)
    .maybeSingle();

  if (re) return bad(500, re.message);

  return NextResponse.json(saved ?? payload);
}

function isFiniteNum(v: any) {
  const n = Number(v);
  return Number.isFinite(n);
}
