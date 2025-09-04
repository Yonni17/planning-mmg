// app/api/admin/generate-planning/route.ts
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
  const c = store.get(base)?.value ?? '';
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

type SlotRow = {
  id: string;
  kind: string;
  period_id: string;
  start_ts: string;
  date: string; // YYYY-MM-DD
};

// ------- util dates & kinds -------
function toDate(d: string) { return new Date(`${d}T00:00:00`); }
function addDays(ymd: string, n: number) { const d = toDate(ymd); d.setDate(d.getDate() + n); return d.toISOString().slice(0,10); }
function isNextDay(d1: string, d2: string) { return toDate(d2).getTime() - toDate(d1).getTime() === 24*3600*1000; }

function isNight(kind: string) {
  return kind === 'WEEKDAY_20_00' || kind === 'SAT_18_00' || kind === 'SUN_20_24';
}
const ENDS_AT_MIDNIGHT: Record<string, boolean> = {
  WEEKDAY_20_00: true, SAT_18_00: true, SUN_20_24: true,
  SUN_08_14: false, SUN_14_20: false, SAT_12_18: false,
};
// ----------------------------------

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { period_id, include_candidates = true, dry_run = true } = body ?? {};

    if (!period_id) return NextResponse.json({ error: 'period_id requis' }, { status: 400 });

    // Auth admin
    const authHeader = req.headers.get('authorization') || '';
    let access_token: string | null = null;
    if (authHeader.toLowerCase().startsWith('bearer ')) access_token = authHeader.slice(7).trim();
    if (!access_token) access_token = await getAccessTokenFromCookies();
    if (!access_token) return NextResponse.json({ error: 'Auth session missing!' }, { status: 401 });

    const { data: userData, error: userErr } = await supabaseAnon.auth.getUser(access_token);
    if (userErr) return NextResponse.json({ error: userErr.message }, { status: 401 });
    const user = userData.user;
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: isAdmin, error: adminErr } = await supabaseService.rpc('is_admin', { uid: user.id });
    if (adminErr) return NextResponse.json({ error: adminErr.message }, { status: 500 });
    if (!isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    // Slots
    const { data: slotsData, error: slotsErr } = await supabaseService
      .from('slots')
      .select('id, kind, period_id, start_ts, date')
      .eq('period_id', period_id)
      .order('start_ts', { ascending: true });
    if (slotsErr) throw slotsErr;
    const slots: SlotRow[] = (slotsData ?? []) as any;
    if (!slots.length) return NextResponse.json({ error: 'Aucun slot pour cette période' }, { status: 400 });

    const slotIds = slots.map(s => s.id);

    // Availability (pagination)
    async function fetchAvailabilityByBatches(ids: string[], idBatch = 200, pageSize = 1000) {
      const out: { user_id: string; slot_id: string; available: boolean }[] = [];
      for (let i = 0; i < ids.length; i += idBatch) {
        const chunk = ids.slice(i, i + idBatch);
        let from = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const to = from + pageSize - 1;
          const { data, error } = await supabaseService
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

    // Build maps
    const availBySlot = new Map<string, Set<string>>();
    const allUsers = new Set<string>();
    for (const a of avRows) {
      if (!a.available) continue;
      if (!availBySlot.has(a.slot_id)) availBySlot.set(a.slot_id, new Set());
      availBySlot.get(a.slot_id)!.add(a.user_id);
      allUsers.add(a.user_id);
    }

    // Targets
    const { data: prefs, error: prefsErr } = await supabaseService
      .from('preferences_period')
      .select('user_id, target_level')
      .eq('period_id', period_id);
    if (prefsErr) throw prefsErr;

    const targetCap = new Map<string, number>(); // Infinity = Max
    const hasPref = new Set((prefs ?? []).map(p => p.user_id));
    for (const u of allUsers) { if (!hasPref.has(u)) targetCap.set(u, Number.POSITIVE_INFINITY); }
    for (const p of (prefs ?? [])) {
      if (!allUsers.has(p.user_id)) continue;
      const tl = Math.max(1, Math.min(5, (p as any).target_level ?? 5));
      targetCap.set(p.user_id, tl === 5 ? Number.POSITIVE_INFINITY : tl);
    }

    // Noms (⚠️ on lit first_name / last_name, plus full_name)
    const { data: profiles, error: profErr } = await supabaseService
      .from('profiles')
      .select('user_id, first_name, last_name');
    if (profErr) throw profErr;

    type Prof = { user_id: string; first_name: string | null; last_name: string | null };
    const profIndex = new Map<string, Prof>();
    (profiles ?? []).forEach((p: any) => profIndex.set(p.user_id, p as Prof));

    const fullNameOf = (uid: string) => {
      const p = profIndex.get(uid);
      if (!p) return uid;
      const fn = (p.first_name ?? '').trim();
      const ln = (p.last_name ?? '').trim();
      const full = `${fn} ${ln}`.trim();
      return full || uid;
    };

    const candidates_by_slot: Record<string, { user_id: string; name: string }[]> = {};
    if (include_candidates) {
      for (const s of slots) {
        const set = availBySlot.get(s.id) ?? new Set();
        candidates_by_slot[s.id] = Array.from(set).map(u => ({ user_id: u, name: fullNameOf(u) }));
      }
    }

    // Rareté
    const availCountByUser = new Map<string, number>();
    for (const u of allUsers) availCountByUser.set(u, 0);
    for (const s of slots) for (const u of (availBySlot.get(s.id) ?? new Set()))
      availCountByUser.set(u, (availCountByUser.get(u) ?? 0) + 1);

    // Structures d’assignation & suivi
    const assignedCount = new Map<string, number>(); for (const u of allUsers) assignedCount.set(u, 0);
    const assignments: { slot_id: string; user_id: string; score: number }[] = [];
    const holes_list: { slot_id: string; date: string; kind: string; candidates: number }[] = [];
    const takenSlot = new Set<string>();

    // anti-enchaînements
    const assignedUsersByDate = new Map<string, Set<string>>();          // date -> users (évite 2/jour)
    const lastAssignedDate = new Map<string, string | null>();            // user -> dernière date
    const lastNightDate = new Map<string, string | null>();               // user -> dernière date "nuit"
    const nightStreak = new Map<string, number>();                        // user -> nb nuits consécutives
    const assignedKindsByUserDate = new Map<string, Map<string, Set<string>>>(); // user -> (date -> kinds)

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
    const userHadNightOnDate = (u: string, date: string) => {
      const kinds = assignedKindsByUserDate.get(u)?.get(date);
      if (!kinds) return false;
      for (const k of kinds) if (isNight(k)) return true;
      return false;
    };

    const eligible = (u: string) => {
      const cap = targetCap.get(u);
      const cnt = assignedCount.get(u) ?? 0;
      if (cap === undefined) return true;
      if (!isFinite(cap)) return true;
      return cnt < cap;
    };

    // Tri stable utilisateurs : rareté -> nom -> id
    const stableCompareUsers = (u1: string, u2: string) => {
      const c1 = availCountByUser.get(u1) ?? 0;
      const c2 = availCountByUser.get(u2) ?? 0;
      if (c1 !== c2) return c1 - c2;
      const n1 = fullNameOf(u1), n2 = fullNameOf(u2);
      const dn = n1.localeCompare(n2, 'fr'); if (dn !== 0) return dn;
      return u1.localeCompare(u2);
    };

    // 1) slots 1 seul candidat
    for (const s of slots) {
      const candSet = availBySlot.get(s.id) ?? new Set();
      if (candSet.size === 1) {
        const only = Array.from(candSet)[0];
        if (!eligible(only)) continue;
        assignments.push({ slot_id: s.id, user_id: only, score: 1 });
        takenSlot.add(s.id);
        assignedCount.set(only, (assignedCount.get(only) ?? 0) + 1);
        markAssigned(only, s.date, s.kind);
      }
    }

    // 2) reste des slots (difficile -> facile)
    const remaining = slots
      .filter(s => !takenSlot.has(s.id))
      .map(s => ({ s, c: (availBySlot.get(s.id)?.size ?? 0) }))
      .sort((a, b) => a.c - b.c || String(a.s.start_ts).localeCompare(String(b.s.start_ts)))
      .map(x => x.s);

    for (const s of remaining) {
      const candAll = Array.from(availBySlot.get(s.id) ?? new Set());
      if (candAll.length === 0) { holes_list.push({ slot_id: s.id, date: s.date, kind: s.kind, candidates: 0 }); continue; }

      // cap d’abord
      const notCapped = candAll.filter(eligible);
      const pool0 = (notCapped.length > 0) ? notCapped : candAll.slice();

      // ======= FILTRES “HARD AVANT CHOIX” =======
      // A. interdire 2 créneaux le même jour si au moins une alternative existe
      const poolNoSameDay = pool0.filter(u => !userHasSameDay(u, s.date));
      const poolA = (poolNoSameDay.length > 0) ? poolNoSameDay : pool0;

      // B. éviter Nuit->Nuit (J+1) et 00:00->Matin (J+1) si alternative
      const poolAvoidHeavy = poolA.filter(u => {
        // nuit->nuit
        if (isNight(s.kind)) {
          const lastN = lastNightDate.get(u);
          if (lastN && isNextDay(lastN, s.date)) return false; // exclure si possible
        }
        // 00:00 -> matin
        if (s.kind === 'SUN_08_14') {
          const y = addDays(s.date, -1);
          const kindsY = assignedKindsByUserDate.get(u)?.get(y);
          if (kindsY) for (const k of kindsY) if (ENDS_AT_MIDNIGHT[k]) return false;
        }
        return true;
      });
      const poolB = (poolAvoidHeavy.length > 0) ? poolAvoidHeavy : poolA;

      // ==========================================

      // Choix = “pool minimal” sur nb de gardes déjà attribuées
      let minCount = Number.POSITIVE_INFINITY;
      for (const u of poolB) { const c = assignedCount.get(u) ?? 0; if (c < minCount) minCount = c; }
      let poolMin = poolB.filter(u => (assignedCount.get(u) ?? 0) === minCount);
      if (poolMin.length === 0) poolMin = poolB.slice();

      // Tie-break doux (rareté, nom, id)
      poolMin.sort(stableCompareUsers);
      const chosen = poolMin[0] ?? null;

      if (!chosen) {
        holes_list.push({ slot_id: s.id, date: s.date, kind: s.kind, candidates: candAll.length });
        continue;
      }

      assignments.push({ slot_id: s.id, user_id: chosen, score: 1 });
      takenSlot.add(s.id);
      assignedCount.set(chosen, (assignedCount.get(chosen) ?? 0) + 1);
      markAssigned(chosen, s.date, s.kind);
    }

    // Sanity : slots sans candidats
    for (const s of slots) {
      if (takenSlot.has(s.id)) continue;
      const c = availBySlot.get(s.id)?.size ?? 0;
      if (c === 0) holes_list.push({ slot_id: s.id, date: s.date, kind: s.kind, candidates: 0 });
    }

    // Enrichissement UI
    const slotById = new Map<string, SlotRow>(slots.map(s => [s.id, s]));
    const enriched = assignments.map(a => ({
      ...a,
      display_name: fullNameOf(a.user_id),
      date: slotById.get(a.slot_id)?.date ?? null,
      kind: slotById.get(a.slot_id)?.kind ?? null,
    })).sort((a, b) => {
      const d = String(a.date ?? '').localeCompare(String(b.date ?? '')); if (d !== 0) return d;
      return String(a.kind ?? '').localeCompare(String(b.kind ?? ''));
    });

    if (dry_run) {
      return NextResponse.json({
        period_id,
        holes: holes_list.length,
        total_score: enriched.length,
        assignments: enriched,
        runs: [{ seed: 0, total_score: enriched.length, holes: holes_list.length }],
        holes_list,
        ...(include_candidates ? { candidates_by_slot } : {}),
      });
    }

    // Écriture DB
    const { error: delErr } = await supabaseService.from('assignments').delete().eq('period_id', period_id);
    if (delErr) throw delErr;
    const rows = assignments.map(a => ({ period_id, slot_id: a.slot_id, user_id: a.user_id, score: a.score }));
    if (rows.length) {
      const { error: insErr } = await supabaseService.from('assignments').insert(rows);
      if (insErr) throw insErr;
    }

    return NextResponse.json({
      ok: true, period_id,
      holes: holes_list.length,
      total_score: assignments.length,
      inserted: rows.length,
    });

  } catch (e: any) {
    console.error('[generate-planning hard-filters]', e);
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 });
  }
}
