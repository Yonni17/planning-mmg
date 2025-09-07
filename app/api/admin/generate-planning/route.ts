// app/api/admin/generate-planning/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SlotRow = {
  id: string;
  kind: string;
  period_id: string;
  start_ts: string;
  date: string; // YYYY-MM-DD
};

// ------- util dates & kinds -------
function toDate(d: string) { return new Date(`${d}T00:00:00`); }
function addDays(ymd: string, n: number) {
  const d = toDate(ymd); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function isNextDay(d1: string, d2: string) {
  return toDate(d2).getTime() - toDate(d1).getTime() === 24 * 3600 * 1000;
}
function isNight(kind: string) {
  return kind === 'WEEKDAY_20_00' || kind === 'SAT_18_00' || kind === 'SUN_20_24';
}
const ENDS_AT_MIDNIGHT: Record<string, boolean> = {
  WEEKDAY_20_00: true, SAT_18_00: true, SUN_20_24: true,
  SUN_08_14: false, SUN_14_20: false, SAT_12_18: false,
};
const monthOf = (ymd: string) => ymd.slice(0, 7);
// ----------------------------------

// ---- Auth helpers (Bearer / cookies) ----
function getAccessTokenFromReq(req: NextRequest): string | null {
  const auth = req.headers.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();

  const c = cookies();
  const direct = c.get('sb-access-token')?.value;
  if (direct) return direct;

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
  } catch {}
  return null;
}

async function requireAdminOrResponse(req: NextRequest) {
  const supabase = getSupabaseAdmin();
  const token = getAccessTokenFromReq(req);
  if (!token) {
    return { errorResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }), supabase, userId: null as string | null };
  }
  const { data: userData, error: uErr } = await supabase.auth.getUser(token);
  if (uErr || !userData?.user) {
    return { errorResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }), supabase, userId: null };
  }
  const uid = userData.user.id;
  const { data: isAdmin, error: aErr } = await supabase.rpc('is_admin', { uid });
  if (aErr || !isAdmin) {
    return { errorResponse: NextResponse.json({ error: 'Forbidden' }, { status: 403 }), supabase, userId: uid };
  }
  return { errorResponse: null as NextResponse | null, supabase, userId: uid };
}
// -----------------------------------------

/**
 * Construit:
 * - slots (ordonnés)
 * - disponibilités par slot + candidates_by_slot
 * - users_index (name, target_level, avail_count)
 *   * inclut aussi les users ayant des préférences de période même sans dispo
 */
async function buildAvailabilitySummary(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  period_id: string
) {
  const { data: slotsData, error: slotsErr } = await supabase
    .from('slots')
    .select('id, kind, period_id, start_ts, date')
    .eq('period_id', period_id)
    .order('start_ts', { ascending: true });
  if (slotsErr) throw slotsErr;

  const slots: SlotRow[] = (slotsData ?? []) as SlotRow[];
  if (!slots.length) {
    return {
      slots: [] as SlotRow[],
      availability_by_slot: {} as Record<string, { date: string; kind: string; candidates: { user_id: string; name: string }[] }>,
      candidates_by_slot: {} as Record<string, { user_id: string; name: string }[]>,
      users_index: {} as Record<string, { name: string; target_level: number | null; avail_count: number }>
    };
  }

  const slotIds = slots.map(s => s.id);

  // Availability (batch)
  async function fetchAvailabilityByBatches(ids: string[], idBatch = 200, pageSize = 1000) {
    const out: { user_id: string; slot_id: string; available: boolean }[] = [];
    for (let i = 0; i < ids.length; i += idBatch) {
      const chunk = ids.slice(i, i + idBatch);
      let from = 0;
      while (true) {
        const to = from + pageSize - 1;
        const { data, error } = await supabase
          .from('availability')
          .select('user_id, slot_id, available')
          .in('slot_id', chunk)
          .range(from, to);
        if (error) throw error;
        const len = data?.length ?? 0;
        if (len) out.push(...(data ?? []));
        if (len < pageSize) break;
        from += pageSize;
      }
    }
    return out;
  }
  const avRows = await fetchAvailabilityByBatches(slotIds, 200, 1000);

  // availBySlot + users set
  const availBySlot = new Map<string, Set<string>>();
  const usersFromAvailability = new Set<string>();
  for (const a of avRows) {
    if (!a.available) continue;
    if (!availBySlot.has(a.slot_id)) availBySlot.set(a.slot_id, new Set());
    availBySlot.get(a.slot_id)!.add(a.user_id);
    usersFromAvailability.add(a.user_id);
  }

  // preferences_period -> targets
  const { data: prefUsers, error: prefUsersErr } = await supabase
    .from('preferences_period')
    .select('user_id, target_level')
    .eq('period_id', period_id);
  if (prefUsersErr) throw prefUsersErr;

  const usersFromPrefs = new Set<string>((prefUsers ?? []).map((p: any) => p.user_id));
  const allUsers = new Set<string>([...Array.from(usersFromAvailability), ...Array.from(usersFromPrefs)]);

  // profiles -> name
  const profIndex = new Map<string, { first_name: string | null; last_name: string | null }>();
  if (allUsers.size > 0) {
    const { data: profiles, error: profErr } = await supabase
      .from('profiles')
      .select('user_id, first_name, last_name')
      .in('user_id', Array.from(allUsers));
    if (profErr) throw profErr;
    (profiles ?? []).forEach((p: any) => {
      profIndex.set(p.user_id, { first_name: p.first_name ?? null, last_name: p.last_name ?? null });
    });
  }

  const fullNameOf = (uid: string) => {
    const p = profIndex.get(uid);
    if (!p) return uid;
    const fn = (p.first_name ?? '').trim();
    const ln = (p.last_name ?? '').trim();
    const full = `${fn} ${ln}`.trim();
    return full || uid;
  };

  // targets map
  const targetCap = new Map<string, number>();
  (prefUsers ?? []).forEach((p: any) => targetCap.set(p.user_id, p.target_level ?? 5));

  // avail count per user
  const availCountByUser = new Map<string, number>();
  for (const u of allUsers) availCountByUser.set(u, 0);
  for (const s of slots) {
    for (const u of availBySlot.get(s.id) ?? new Set<string>()) {
      availCountByUser.set(u, (availCountByUser.get(u) ?? 0) + 1);
    }
  }

  // per-slot candidates with names
  const availability_by_slot: Record<string, { date: string; kind: string; candidates: { user_id: string; name: string }[] }> = {};
  const candidates_by_slot: Record<string, { user_id: string; name: string }[]> = {};
  for (const s of slots) {
    const set = availBySlot.get(s.id) ?? new Set<string>();
    const cand = Array.from(set).map(u => ({ user_id: u, name: fullNameOf(u) }));
    availability_by_slot[s.id] = { date: s.date, kind: s.kind, candidates: cand };
    candidates_by_slot[s.id] = cand;
  }

  const users_index: Record<string, { name: string; target_level: number | null; avail_count: number }> = {};
  for (const u of allUsers) {
    users_index[u] = {
      name: fullNameOf(u),
      target_level: targetCap.has(u) ? (targetCap.get(u) as number) : null,
      avail_count: availCountByUser.get(u) ?? 0,
    };
  }

  return { slots, availability_by_slot, candidates_by_slot, users_index };
}

// ============== GET ==============
export async function GET(req: NextRequest) {
  try {
    const { errorResponse, supabase } = await requireAdminOrResponse(req);
    if (errorResponse) return errorResponse;

    const period_id = req.nextUrl.searchParams.get('period_id') || '';
    if (!period_id) return NextResponse.json({ error: 'period_id requis' }, { status: 400 });

    const { slots, availability_by_slot, candidates_by_slot, users_index } =
      await buildAvailabilitySummary(supabase, period_id);

    return NextResponse.json({
      period_id,
      slots_count: slots.length,
      slots,
      availability_by_slot,
      candidates_by_slot,
      users_index,
    });
  } catch (e: any) {
    console.error('[generate-planning GET]', e);
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 });
  }
}

// ===== Helpers quotas mensuels =====
type PrefMonthRow = { user_id: string; month: string; target_total: number };

// ============== POST ==============
export async function POST(req: NextRequest) {
  try {
    const { errorResponse, supabase } = await requireAdminOrResponse(req);
    if (errorResponse) return errorResponse;

    const body = await req.json().catch(() => ({}));
    const {
      period_id,
      include_candidates = true,
      dry_run = true,
    }: { period_id?: string; include_candidates?: boolean; dry_run?: boolean } = body ?? {};

    if (!period_id) {
      return NextResponse.json({ error: 'period_id requis' }, { status: 400 });
    }

    // Base: slots + summary
    const { slots, availability_by_slot, candidates_by_slot, users_index } =
      await buildAvailabilitySummary(supabase, period_id);
    if (!slots.length) return NextResponse.json({ error: 'Aucun slot pour cette période' }, { status: 400 });

    const availBySlot = new Map<string, Set<string>>();
    const allUsers = new Set<string>();
    Object.entries(availability_by_slot).forEach(([slot_id, v]) => {
      const set = new Set<string>(v.candidates.map(c => c.user_id));
      availBySlot.set(slot_id, set);
      for (const u of set) allUsers.add(u);
    });

    const fullNameOf = (uid: string) => users_index[uid]?.name ?? uid;

    // Targets: 5/null = Max (∞), 1..4 = cap mensuel
    const perMonthCap = new Map<string, number | 'MAX'>(); // 'MAX' pour infini
    for (const u of allUsers) {
      const tl = users_index[u]?.target_level;
      if (tl == null || tl === 5) perMonthCap.set(u, 'MAX');
      else perMonthCap.set(u, Math.max(1, Math.min(4, tl))); // 1..4
    }

    // Rareté globale par user
    const availCountByUser = new Map<string, number>();
    for (const u of allUsers) availCountByUser.set(u, users_index[u]?.avail_count ?? 0);

    // Préparation “mois par mois”
    const months = Array.from(new Set(slots.map(s => monthOf(s.date)))).sort();

    // Dispos par user & mois
    const disposByUserMonth = new Map<string, Map<string, number>>();
    for (const m of months) {
      const monthSlots = slots.filter(s => monthOf(s.date) === m);
      for (const s of monthSlots) {
        const set = availBySlot.get(s.id) ?? new Set<string>();
        for (const u of set) {
          if (!disposByUserMonth.has(u)) disposByUserMonth.set(u, new Map());
          const mm = disposByUserMonth.get(u)!;
          mm.set(m, (mm.get(m) ?? 0) + 1);
        }
      }
    }

    // preferences_month (si existant)
    const { data: pmRows } = await supabase
      .from('preferences_month')
      .select('user_id, month, target_total')
      .eq('period_id', period_id);
    const pmByUser = new Map<string, Map<string, number>>();
    for (const r of (pmRows ?? []) as PrefMonthRow[]) {
      if (!pmByUser.has(r.user_id)) pmByUser.set(r.user_id, new Map());
      pmByUser.get(r.user_id)!.set(r.month, Math.max(0, Number(r.target_total || 0)));
    }

    // Quotas mensuels
    const quotaByUserMonth = new Map<string, Map<string, number>>();
    for (const u of allUsers) {
      const capM = perMonthCap.get(u)!; // 'MAX' ou 1..4
      const prefU = pmByUser.get(u);
      const dispU = disposByUserMonth.get(u) ?? new Map();
      const out = new Map<string, number>();

      if (prefU && Array.from(prefU.values()).some(v => (v ?? 0) > 0)) {
        // Respecte preferences_month
        for (const m of months) out.set(m, Math.max(0, prefU.get(m) ?? 0));
      } else {
        if (capM === 'MAX') {
          // Max -> soft 1 par mois avec dispo (pour étaler)
          months.forEach(m => out.set(m, (dispU.get(m) ?? 0) > 0 ? 1 : 0));
        } else {
          // Cap mensuel dur = tl par mois (0 si aucune dispo ce mois)
          months.forEach(m => out.set(m, (dispU.get(m) ?? 0) > 0 ? capM as number : 0));
        }
      }
      quotaByUserMonth.set(u, out);
    }

    // Cap global = somme des quotas mensuels (infini pour MAX)
    const totalCapByUser = new Map<string, number>();
    for (const u of allUsers) {
      const capM = perMonthCap.get(u)!;
      if (capM === 'MAX') {
        totalCapByUser.set(u, Number.POSITIVE_INFINITY);
      } else {
        const q = quotaByUserMonth.get(u)!;
        let sum = 0;
        for (const m of months) sum += (q.get(m) ?? 0);
        totalCapByUser.set(u, sum);
      }
    }

    // Structures d’assignation cross-mois
    const assignments: { slot_id: string; user_id: string; score: number }[] = [];
    const holes_list: { slot_id: string; date: string; kind: string; candidates: number }[] = [];
    const takenSlot = new Set<string>();

    const assignedCount = new Map<string, number>();
    for (const u of allUsers) assignedCount.set(u, 0);

    const assignedCountByMonth = new Map<string, Map<string, number>>();
    const incAssigned = (u: string, m: string) => {
      assignedCount.set(u, (assignedCount.get(u) ?? 0) + 1);
      if (!assignedCountByMonth.has(u)) assignedCountByMonth.set(u, new Map());
      const mm = assignedCountByMonth.get(u)!;
      mm.set(m, (mm.get(m) ?? 0) + 1);
    };

    // Anti-enchaînements (cross-mois)
    const assignedUsersByDate = new Map<string, Set<string>>();
    const lastAssignedDate = new Map<string, string | null>();
    const lastNightDate = new Map<string, string | null>();
    const nightStreak = new Map<string, number>();
    const assignedKindsByUserDate = new Map<string, Map<string, Set<string>>>();

    function markAssigned(u: string, date: string, kind: string) {
      if (!assignedUsersByDate.has(date)) assignedUsersByDate.set(date, new Set());
      assignedUsersByDate.get(date)!.add(u);
      lastAssignedDate.set(u, date);

      if (!assignedKindsByUserDate.has(u)) assignedKindsByUserDate.set(u, new Map());
      const m = assignedKindsByUserDate.get(u)!;
      if (!m.has(date)) m.set(date, new Set());
      m.get(date)!.add(kind);

      if (isNight(kind)) {
        const last = lastNightDate.get(u);
        const streak = nightStreak.get(u) ?? 0;
        if (last && isNextDay(last, date)) nightStreak.set(u, streak + 1);
        else nightStreak.set(u, 1);
        lastNightDate.set(u, date);
      }
    }

    const userHasSameDay = (u: string, date: string) => assignedUsersByDate.get(date)?.has(u) ?? false;

    // Besoins restants globaux
    const remainingTotalNeed = new Map<string, number>();
    for (const u of allUsers) remainingTotalNeed.set(u, totalCapByUser.get(u)!);

    const isFiniteTarget = (u: string) => perMonthCap.get(u)! !== 'MAX';

    // Tri stable
    const stableCompareUsers = (u1: string, u2: string) => {
      const c1 = availCountByUser.get(u1) ?? 0;
      const c2 = availCountByUser.get(u2) ?? 0;
      if (c1 !== c2) return c1 - c2;
      const dn = (users_index[u1]?.name ?? u1).localeCompare(users_index[u2]?.name ?? u2, 'fr');
      if (dn !== 0) return dn;
      return u1.localeCompare(u2);
    };

    // ---------- Assignation pour 1 mois ----------
    const assignForMonth = (month: string) => {
      // besoins mensuels restants
      const remainingMonthNeed = new Map<string, number>();
      for (const u of allUsers) {
        const q = quotaByUserMonth.get(u)?.get(month) ?? 0;
        const already = assignedCountByMonth.get(u)?.get(month) ?? 0;
        remainingMonthNeed.set(u, Math.max(0, q - already));
      }

      // criticité future (mois suivants) — pour éviter de “manger” les uniques
      const mIndex = months.indexOf(month);
      const futureMonths = months.slice(mIndex + 1);
      const criticalFuture = new Map<string, number>();
      if (futureMonths.length > 0) {
        for (const fm of futureMonths) {
          for (const s of slots) {
            if (takenSlot.has(s.id)) continue;
            if (monthOf(s.date) !== fm) continue;
            const set = availBySlot.get(s.id) ?? new Set<string>();
            if (set.size === 1) {
              const only = Array.from(set)[0];
              criticalFuture.set(only, (criticalFuture.get(only) ?? 0) + 1);
            }
          }
        }
      }

      const monthSlots = slots.filter((s) => !takenSlot.has(s.id) && monthOf(s.date) === month);

      // 1) Slots à 1 seul candidat (on *peut* dépasser le quota mensuel si c’est le seul candidat)
      for (const s of monthSlots) {
        if (takenSlot.has(s.id)) continue;
        const set = availBySlot.get(s.id) ?? new Set<string>();
        if (set.size === 1) {
          const only = Array.from(set)[0];
          const totNeed = remainingTotalNeed.get(only) ?? 0;
          if (totNeed <= 0 && isFiniteTarget(only)) continue; // déjà au total cap

          // si fini & plus de quota mensuel, on accepte *exceptionnellement* pour éviter un trou
          assignments.push({ slot_id: s.id, user_id: only, score: 1 });
          takenSlot.add(s.id);
          incAssigned(only, month);

          if (isFiniteTarget(only)) {
            if (totNeed > 0) remainingTotalNeed.set(only, totNeed - 1);
            const mon = remainingMonthNeed.get(only) ?? 0;
            if (mon > 0) remainingMonthNeed.set(only, mon - 1);
          }
          markAssigned(only, s.date, s.kind);
        }
      }

      // 2) Reste des slots rare -> commun
      const remaining = monthSlots
        .filter((s) => !takenSlot.has(s.id))
        .map((s) => ({ s, c: (availBySlot.get(s.id)?.size ?? 0) }))
        .sort((a, b) => a.c - b.c || String(a.s.start_ts).localeCompare(String(b.s.start_ts)))
        .map((x) => x.s);

      for (const s of remaining) {
        const candAll = Array.from(availBySlot.get(s.id) ?? new Set<string>());
        if (candAll.length === 0) {
          holes_list.push({ slot_id: s.id, date: s.date, kind: s.kind, candidates: 0 });
          continue;
        }

        // --- PRIORITÉS DE POOL ---
        // P1: finis avec besoin mensuel > 0 (respect cap mensuel)
        const P1 = candAll.filter(u =>
          isFiniteTarget(u) &&
          (remainingTotalNeed.get(u) ?? 0) > 0 &&
          (remainingMonthNeed.get(u) ?? 0) > 0
        );

        // P2: Max avec “soft” besoin mensuel > 0
        const P2 = candAll.filter(u =>
          !isFiniteTarget(u) &&
          (remainingMonthNeed.get(u) ?? 0) > 0
        );

        // P3: autres (Max sans soft besoin) — en dernier recours
        const P3 = candAll.filter(u => !P1.includes(u) && !P2.includes(u));

        let pool0: string[] =
          (P1.length > 0) ? P1 :
          (P2.length > 0) ? P2 :
          P3;

        // A. interdire 2 créneaux le même jour si alternative
        const poolNoSameDay = pool0.filter((u) => !userHasSameDay(u, s.date));
        const poolA = poolNoSameDay.length > 0 ? poolNoSameDay : pool0;

        // B. éviter Nuit->Nuit (J+1) & Nuit->Matin (J+1) si alternative
        const poolAvoidHeavy = poolA.filter((u) => {
          if (isNight(s.kind)) {
            const lastN = lastNightDate.get(u);
            if (lastN && isNextDay(lastN, s.date)) return false;
          }
          if (s.kind === 'SUN_08_14') {
            const y = addDays(s.date, -1);
            const kindsY = assignedKindsByUserDate.get(u)?.get(y);
            if (kindsY) for (const k of kindsY) if (ENDS_AT_MIDNIGHT[k]) return false;
          }
          return true;
        });
        const poolB = poolAvoidHeavy.length > 0 ? poolAvoidHeavy : poolA;

        // C. réserve criticité future pour finis (si alternative)
        const poolKeepFuture = poolB.filter((u) => {
          const cf = criticalFuture.get(u) ?? 0;
          if (cf <= 0) return true;
          if (!isFiniteTarget(u)) return true; // Max: ne bloque pas
          const tot = remainingTotalNeed.get(u) ?? 0;
          return (tot - 1) >= cf;
        });
        const poolC = poolKeepFuture.length > 0 ? poolKeepFuture : poolB;

        // Choix = moins servi globalement, puis rareté globale, puis nom (stable)
        let minCount = Number.POSITIVE_INFINITY;
        for (const u of poolC) {
          const c = assignedCount.get(u) ?? 0;
          if (c < minCount) minCount = c;
        }
        let poolMin = poolC.filter((u) => (assignedCount.get(u) ?? 0) === minCount);
        if (poolMin.length === 0) poolMin = poolC.slice();
        poolMin.sort(stableCompareUsers);

        const chosen = poolMin[0] ?? null;

        if (!chosen) {
          holes_list.push({ slot_id: s.id, date: s.date, kind: s.kind, candidates: candAll.length });
          continue;
        }

        // Assignation & décréments
        assignments.push({ slot_id: s.id, user_id: chosen, score: 1 });
        takenSlot.add(s.id);
        incAssigned(chosen, month);

        if (isFiniteTarget(chosen)) {
          const tot = remainingTotalNeed.get(chosen) ?? 0;
          if (tot > 0) remainingTotalNeed.set(chosen, tot - 1);
          const mon = remainingMonthNeed.get(chosen) ?? 0;
          if (mon > 0) remainingMonthNeed.set(chosen, mon - 1);
        }

        markAssigned(chosen, s.date, s.kind);
      }
    };

    // 3 passes : M1 -> M2 -> M3
    for (const m of months) {
      assignForMonth(m);
    }

    // Enrichissement UI
    const slotById = new Map<string, SlotRow>(slots.map((s) => [s.id, s]));
    const enriched = assignments
      .map((a) => ({
        ...a,
        display_name: fullNameOf(a.user_id),
        date: slotById.get(a.slot_id)?.date ?? null,
        kind: slotById.get(a.slot_id)?.kind ?? null,
      }))
      .sort((a, b) => {
        const d = String(a.date ?? '').localeCompare(String(b.date ?? ''));
        if (d !== 0) return d;
        return String(a.kind ?? '').localeCompare(String(b.kind ?? ''));
      });

    // candidats by slot si demandé
    let out_candidates_by_slot: Record<string, { user_id: string; name: string }[]> | undefined;
    if (include_candidates) {
      out_candidates_by_slot = {};
      for (const s of slots) {
        const set = availBySlot.get(s.id) ?? new Set<string>();
        out_candidates_by_slot[s.id] = Array.from(set).map((u) => ({ user_id: u, name: fullNameOf(u) }));
      }
    }

    if (dry_run) {
      return NextResponse.json({
        period_id,
        holes: holes_list.length,
        total_score: enriched.length,
        assignments: enriched,
        runs: [{ seed: 0, total_score: enriched.length, holes: holes_list.length }],
        holes_list,
        ...(out_candidates_by_slot ? { candidates_by_slot: out_candidates_by_slot } : {}),
        users_index: Object.fromEntries(
          Object.keys(users_index).map(uid => [
            uid,
            { ...users_index[uid], assigned_count: 0 }
          ])
        ),
        availability_summary: { availability_by_slot, users_index },
      });
    }

    // Écriture DB
    const { error: delErr } = await supabase.from('assignments').delete().eq('period_id', period_id);
    if (delErr) throw delErr;

    const rows = assignments.map((a) => ({ period_id, slot_id: a.slot_id, user_id: a.user_id, score: a.score }));
    if (rows.length) {
      const { error: insErr } = await supabase.from('assignments').insert(rows);
      if (insErr) throw insErr;
    }

    // assigned_count final (pour users_index)
    const assignedCountOut: Record<string, number> = {};
    for (const [u, c] of assignedCount.entries()) assignedCountOut[u] = c;

    const users_index_out = Object.fromEntries(
      Object.keys(users_index).map(uid => [
        uid,
        { ...users_index[uid], assigned_count: assignedCountOut[uid] ?? 0 }
      ])
    );

    return NextResponse.json({
      ok: true,
      period_id,
      holes: holes_list.length,
      total_score: rows.length,
      inserted: rows.length,
      assignments: enriched,
      ...(out_candidates_by_slot ? { candidates_by_slot: out_candidates_by_slot } : {}),
      users_index: users_index_out,
      availability_summary: { availability_by_slot, users_index },
    });
  } catch (e: any) {
    console.error('[generate-planning hard-filters]', e);
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 });
  }
}
