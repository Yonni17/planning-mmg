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
// util mois
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
 * - slots de la période (ordonnés)
 * - disponibilités par slot (avec user names) + candidates_by_slot
 * - index utilisateurs (name, target_level, avail_count)
 *   * inclut aussi les users ayant des préférences de période même sans dispo
 */
async function buildAvailabilitySummary(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  period_id: string
) {
  // 1) Slots
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

  // 2) Availability (batch paginé)
  async function fetchAvailabilityByBatches(ids: string[], idBatch = 200, pageSize = 1000) {
    const out: { user_id: string; slot_id: string; available: boolean }[] = [];
    for (let i = 0; i < ids.length; i += idBatch) {
      const chunk = ids.slice(i, i + idBatch);
      let from = 0;
      // eslint-disable-next-line no-constant-condition
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

  // 3) Ids utilisateurs à considérer
  const availBySlot = new Map<string, Set<string>>();
  const usersFromAvailability = new Set<string>();
  for (const a of avRows) {
    if (!a.available) continue;
    if (!availBySlot.has(a.slot_id)) availBySlot.set(a.slot_id, new Set());
    availBySlot.get(a.slot_id)!.add(a.user_id);
    usersFromAvailability.add(a.user_id);
  }

  // Inclure aussi ceux qui ont des préférences de période (même sans dispo)
  const { data: prefUsers, error: prefUsersErr } = await supabase
    .from('preferences_period')
    .select('user_id, target_level')
    .eq('period_id', period_id);
  if (prefUsersErr) throw prefUsersErr;

  const usersFromPrefs = new Set<string>((prefUsers ?? []).map((p: any) => p.user_id));
  const allUsers = new Set<string>([...Array.from(usersFromAvailability), ...Array.from(usersFromPrefs)]);

  // 4) Profiles (pour les noms)
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

  // 5) Targets
  const targetCap = new Map<string, number>();
  (prefUsers ?? []).forEach((p: any) => targetCap.set(p.user_id, p.target_level ?? 5));

  // 6) avail count par user (0 par défaut)
  const availCountByUser = new Map<string, number>();
  for (const u of allUsers) availCountByUser.set(u, 0);
  for (const s of slots) {
    for (const u of availBySlot.get(s.id) ?? new Set<string>()) {
      availCountByUser.set(u, (availCountByUser.get(u) ?? 0) + 1);
    }
  }

  // 7) availability_by_slot + candidates_by_slot (avec noms)
  const availability_by_slot: Record<string, { date: string; kind: string; candidates: { user_id: string; name: string }[] }> = {};
  const candidates_by_slot: Record<string, { user_id: string; name: string }[]> = {};
  for (const s of slots) {
    const set = availBySlot.get(s.id) ?? new Set<string>();
    const cand = Array.from(set).map(u => ({ user_id: u, name: fullNameOf(u) }));
    availability_by_slot[s.id] = { date: s.date, kind: s.kind, candidates: cand };
    candidates_by_slot[s.id] = cand;
  }

  // 8) users_index (pour *tous* les users considérés)
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
// Résumé disponibilités (pour afficher "Disponibilités par créneau" tout le temps)
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

    // ---- Base: slots + summary (sert aussi pour l’UI même sans génération)
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

    // === Cap mensuel uniquement ===
    // perMonthCap[u] = ∞ si target_level null/5, sinon 1..4 (interprété comme quota PAR MOIS)
    const perMonthCap = new Map<string, number>();
    for (const u of allUsers) {
      const tl = users_index[u]?.target_level;
      if (tl == null || tl === 5) perMonthCap.set(u, Number.POSITIVE_INFINITY);
      else perMonthCap.set(u, Math.max(1, Math.min(4, tl)));
    }

    // Rareté (tie-breaker inchangé)
    const availCountByUser = new Map<string, number>();
    for (const u of allUsers) availCountByUser.set(u, users_index[u]?.avail_count ?? 0);

    // Structures d’assignation & suivi
    const assignedCount = new Map<string, number>(); // global (pour l'équité)
    for (const u of allUsers) assignedCount.set(u, 0);

    // Compteurs mensuels
    const assignedCountByMonth = new Map<string, Map<string, number>>();
    const incAssigned = (u: string, date: string) => {
      assignedCount.set(u, (assignedCount.get(u) ?? 0) + 1); // équité globale conservée
      const m = monthOf(date);
      if (!assignedCountByMonth.has(u)) assignedCountByMonth.set(u, new Map());
      const mm = assignedCountByMonth.get(u)!;
      mm.set(m, (mm.get(m) ?? 0) + 1);
    };

    const assignments: { slot_id: string; user_id: string; score: number }[] = [];
    const holes_list: { slot_id: string; date: string; kind: string; candidates: number }[] = [];
    const takenSlot = new Set<string>();

    // anti-enchaînements
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

    // === éligibilité : **uniquement** le cap mensuel + garde-fous ===
    function eligible(u: string, date: string) {
      const m = monthOf(date);
      const mCap = perMonthCap.get(u) ?? Number.POSITIVE_INFINITY;
      const mCnt = assignedCountByMonth.get(u)?.get(m) ?? 0;
      if (isFinite(mCap) && mCnt >= mCap) return false; // plafond mensuel respecté
      return true;
    }

    const stableCompareUsers = (u1: string, u2: string) => {
      const c1 = availCountByUser.get(u1) ?? 0;
      const c2 = availCountByUser.get(u2) ?? 0;
      if (c1 !== c2) return c1 - c2;
      const dn = fullNameOf(u1).localeCompare(fullNameOf(u2), 'fr');
      if (dn !== 0) return dn;
      return u1.localeCompare(u2);
    };

    // 1) slots 1 seul candidat
    for (const s of slots) {
      const candSet = availBySlot.get(s.id) ?? new Set<string>();
      if (candSet.size === 1) {
        const only = Array.from(candSet)[0];
        if (!eligible(only, s.date)) continue;
        assignments.push({ slot_id: s.id, user_id: only, score: 1 });
        takenSlot.add(s.id);
        incAssigned(only, s.date);
        markAssigned(only, s.date, s.kind);
      }
    }

    // 2) reste des slots (difficile -> facile)
    const remaining = slots
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

      const notCapped = candAll.filter((u) => eligible(u, s.date));
      const pool0 = notCapped.length > 0 ? notCapped : candAll.slice();

      // A. interdire 2 créneaux le même jour si alternative
      const poolNoSameDay = pool0.filter((u) => !userHasSameDay(u, s.date));
      const poolA = poolNoSameDay.length > 0 ? poolNoSameDay : pool0;

      // B. éviter Nuit->Nuit (J+1) et 00:00->Matin (J+1) si alternative
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

      // Choix = “pool minimal” sur nb déjà attribuées (équité globale)
      let minCount = Number.POSITIVE_INFINITY;
      for (const u of poolB) {
        const c = assignedCount.get(u) ?? 0;
        if (c < minCount) minCount = c;
      }
      let poolMin = poolB.filter((u) => (assignedCount.get(u) ?? 0) === minCount);
      if (poolMin.length === 0) poolMin = poolB.slice();

      poolMin.sort(stableCompareUsers);
      const chosen = poolMin[0] ?? null;

      if (!chosen) {
        holes_list.push({ slot_id: s.id, date: s.date, kind: s.kind, candidates: candAll.length });
        continue;
      }

      // garde-fou (au cas où)
      if (!eligible(chosen, s.date)) {
        holes_list.push({ slot_id: s.id, date: s.date, kind: s.kind, candidates: candAll.length });
        continue;
      }

      assignments.push({ slot_id: s.id, user_id: chosen, score: 1 });
      takenSlot.add(s.id);
      incAssigned(chosen, s.date);
      markAssigned(chosen, s.date, s.kind);
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

    // candidats by slot (avec noms) si demandé
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
    console.error('[generate-planning monthly-only cap]', e);
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 });
  }
}
