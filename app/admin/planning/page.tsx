// app/admin/planning/page.tsx
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type SlotKind =
  | 'WEEKDAY_20_00'
  | 'SAT_12_18'
  | 'SAT_18_00'
  | 'SUN_08_14'
  | 'SUN_14_20'
  | 'SUN_20_24';

const KIND_TIME: Record<string, [string, string]> = {
  WEEKDAY_20_00: ['20:00', '00:00'],
  SAT_12_18: ['12:00', '18:00'],
  SAT_18_00: ['18:00', '00:00'],
  SUN_08_14: ['08:00', '14:00'],
  SUN_14_20: ['14:00', '20:00'],
  SUN_20_24: ['20:00', '00:00'],
};

function formatDateLongFR(ymd?: string | null) {
  if (!ymd) return '—';
  const d = new Date(`${ymd}T00:00:00`);
  const day = d.toLocaleDateString('fr-FR', { weekday: 'long' });
  const month = d.toLocaleDateString('fr-FR', { month: 'long' });
  const dd = d.getDate();
  const ddStr = dd === 1 ? '1er' : String(dd);
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return `${cap(day)} ${ddStr} ${month}`;
}
function formatKindRange(kind?: string | null) {
  if (!kind) return '—';
  const t = KIND_TIME[kind];
  if (!t) return kind;
  const h = (s: string) => s.replace(':', 'h');
  return `${h(t[0])} - ${h(t[1])}`;
}

type Period = { id: string; label: string };
type SlotRow = { id: string; kind: string; date: string; start_ts: string };

type AssignmentRow = {
  slot_id: string;
  user_id: string;
  display_name: string;
  score: number;
  date: string | null;
  kind: string | null;
};

type Candidate = { user_id: string; name: string };
type CandidatesBySlot = Record<string, Candidate[]>;

type ResultPayload = {
  period_id: string;
  holes: number;
  total_score: number;
  assignments: AssignmentRow[];
  runs: { seed: number; total_score: number; holes: number }[];
  holes_list: { slot_id: string; date: string; kind: string; candidates: number }[];
  candidates_by_slot?: CandidatesBySlot;
};

export default function PlanningPage() {
  const [periods, setPeriods] = useState<Period[]>([]);
  const [periodId, setPeriodId] = useState<string>('');
  const [loading, setLoading] = useState(false);

  const [result, setResult] = useState<ResultPayload | null>(null);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // Pour la répartition + grille des dispos
  const [profiles, setProfiles] = useState<{ user_id: string; full_name: string }[]>([]);
  const [targets, setTargets] = useState<Map<string, number>>(new Map());
  const [slots, setSlots] = useState<SlotRow[]>([]);
  const [avail, setAvail] = useState<Map<string, Set<string>>>(new Map());
  const [monthFilter, setMonthFilter] = useState<string>('');

  // scroll synchronisé (barre du haut)
  const topScrollerRef = useRef<HTMLDivElement | null>(null);
  const bottomScrollerRef = useRef<HTMLDivElement | null>(null);
  const [scrollWidth, setScrollWidth] = useState<number>(0);
  const syncing = useRef<'top' | 'bottom' | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('periods').select('id,label').order('label');
      setPeriods((data as any) ?? []);
    })();
  }, []);

  // Charge données auxiliaires (slots, profiles, targets, availability)
  useEffect(() => {
    if (!periodId) return;
    (async () => {
      setLoading(true);

      const { data: slotsData } = await supabase
        .from('slots')
        .select('id, kind, date, start_ts')
        .eq('period_id', periodId)
        .order('start_ts', { ascending: true });
      const s: SlotRow[] = (slotsData ?? []) as any;
      setSlots(s);

      // Récupère first_name/last_name aussi pour construire le nom si full_name est nul
      const { data: profData } = await supabase
        .from('profiles')
        .select('user_id, full_name, first_name, last_name');
      const profs = (profData as any[]) ?? [];
      setProfiles(
        profs.map((p) => ({
          user_id: p.user_id,
          full_name:
            (p.full_name && String(p.full_name).trim()) ||
            `${(p.first_name ?? '').trim()} ${(p.last_name ?? '').trim()}`.trim() ||
            p.user_id,
        }))
      );

      const { data: prefs } = await supabase
        .from('preferences_period')
        .select('user_id, target_level')
        .eq('period_id', periodId);
      const t = new Map<string, number>();
      for (const p of prefs ?? []) {
        const tl = Math.max(1, Math.min(5, (p as any).target_level ?? 5));
        t.set((p as any).user_id, tl);
      }
      setTargets(t);

      const slotIds = s.map((x) => x.id);
      const bigSet = new Map<string, Set<string>>();
      for (let i = 0; i < slotIds.length; i += 200) {
        const chunk = slotIds.slice(i, i + 200);
        let from = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const to = from + 1000 - 1;
          const { data } = await supabase
            .from('availability')
            .select('user_id, slot_id, available')
            .in('slot_id', chunk)
            .range(from, to);
          const rows = (data ?? []) as { user_id: string; slot_id: string; available: boolean }[];
          if (!rows.length) break;
          for (const r of rows) {
            if (!r.available) continue;
            if (!bigSet.has(r.slot_id)) bigSet.set(r.slot_id, new Set());
            bigSet.get(r.slot_id)!.add(r.user_id);
          }
          if (rows.length < 1000) break;
          from += 1000;
        }
      }
      setAvail(bigSet);

      const first = s[0]?.date;
      if (first) setMonthFilter(first.slice(0, 7));

      setLoading(false);
    })();
  }, [periodId]);

  // met à jour la largeur à scroller (haut) selon le tableau réel (bas)
  useEffect(() => {
    const el = bottomScrollerRef.current;
    if (!el) return;
    // petit délai pour laisser le DOM peindre
    const id = setTimeout(() => setScrollWidth(el.scrollWidth), 0);
    return () => clearTimeout(id);
  }, [slots, avail, profiles, monthFilter]);

  const onTopScroll = () => {
    if (!topScrollerRef.current || !bottomScrollerRef.current) return;
    if (syncing.current === 'bottom') return;
    syncing.current = 'top';
    bottomScrollerRef.current.scrollLeft = topScrollerRef.current.scrollLeft;
    syncing.current = null;
  };
  const onBottomScroll = () => {
    if (!topScrollerRef.current || !bottomScrollerRef.current) return;
    if (syncing.current === 'top') return;
    syncing.current = 'bottom';
    topScrollerRef.current.scrollLeft = bottomScrollerRef.current.scrollLeft;
    syncing.current = null;
  };

  const monthOptions = useMemo(() => {
    const set = new Set<string>();
    for (const s of slots) if (s.date) set.add(s.date.slice(0, 7));
    return Array.from(set).sort();
  }, [slots]);

  const filteredSlots = useMemo(() => {
    if (!monthFilter) return slots;
    return slots.filter((s) => s.date.startsWith(monthFilter));
  }, [slots, monthFilter]);

  // Générer (appel simple à l’API)
  async function generate() {
    if (!periodId) return;
    setLoading(true);
    setResult(null);
    setEdited({});
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      const res = await fetch('/api/admin/generate-planning', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          period_id: periodId,
          dry_run: true,
          include_candidates: true,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? 'Erreur serveur');

      const sorted = (json.assignments as AssignmentRow[]).slice().sort((a, b) => {
        const d = String(a.date ?? '').localeCompare(String(b.date ?? ''));
        if (d !== 0) return d;
        return String(a.kind ?? '').localeCompare(String(b.kind ?? ''));
      });

      setResult({ ...json, assignments: sorted });
    } catch (e: any) {
      alert(e?.message ?? 'Erreur');
    } finally {
      setLoading(false);
    }
  }

  function setEditedUser(slot_id: string, user_id: string) {
    setEdited((prev) => ({ ...prev, [slot_id]: user_id }));
  }

  async function save() {
    if (!result || !periodId) return;
    setSaving(true);
    try {
      const rows = result.assignments.map((row) => ({
        slot_id: row.slot_id,
        user_id: edited[row.slot_id] ?? row.user_id,
        score: row.score,
      }));
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      const res = await fetch('/api/admin/save-assignments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ period_id: periodId, rows }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? "Erreur d'enregistrement");

      alert(`Assignations enregistrées (${json.inserted}) ✅`);
    } catch (e: any) {
      alert(e?.message ?? 'Impossible d’enregistrer');
    } finally {
      setSaving(false);
    }
  }

  async function sendEmails() {
    if (!periodId) return;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const res = await fetch('/api/admin/email-planning', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ period_id: periodId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? 'Échec envoi');
      alert(`Planning envoyé à ${json.sent_count} médecins ✅`);
    } catch (e: any) {
      alert(e?.message ?? 'Impossible d’envoyer les emails');
    }
  }

  // Name map (full_name || first+last || id)
  const nameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of profiles) m.set(p.user_id, p.full_name ?? p.user_id);
    if (result) {
      for (const a of result.assignments) {
        if (!m.has(a.user_id)) m.set(a.user_id, a.display_name ?? a.user_id);
      }
      const cands = result.candidates_by_slot ?? {};
      for (const list of Object.values(cands)) {
        for (const c of list) if (!m.has(c.user_id)) m.set(c.user_id, c.name ?? c.user_id);
      }
    }
    return m;
  }, [profiles, result]);

  // Répartition
  const doctorRows = useMemo(() => {
    const count = new Map<string, number>();
    const allUserIds = new Set<string>();
    for (const p of profiles) allUserIds.add(p.user_id);
    for (const [u] of targets) allUserIds.add(u);
    for (const set of avail.values()) for (const u of set) allUserIds.add(u);
    for (const u of allUserIds) count.set(u, 0);

    if (result) {
      for (const a of result.assignments) {
        const uid = edited[a.slot_id] ?? a.user_id;
        count.set(uid, (count.get(uid) ?? 0) + 1);
      }
    }

    const availCount = new Map<string, number>();
    for (const u of allUserIds) availCount.set(u, 0);
    for (const s of slots) {
      const set = avail.get(s.id) ?? new Set<string>();
      for (const u of set) availCount.set(u, (availCount.get(u) ?? 0) + 1);
    }

    const rows = Array.from(allUserIds).map((u) => {
      const assigned = count.get(u) ?? 0;
      const target = targets.get(u) ?? 5;
      const targetLabel = target === 5 ? 'Max' : String(target);
      const dispos = availCount.get(u) ?? 0;
      const ecart = target === 5 ? '—' : String(assigned - target);
      return {
        user_id: u,
        name: nameMap.get(u) ?? u,
        assigned,
        target,
        targetLabel,
        dispos,
        ecart,
      };
    });

    rows.sort((a, b) => (b.assigned - a.assigned) || a.name.localeCompare(b.name, 'fr'));
    return rows;
  }, [result, edited, profiles, targets, avail, slots, nameMap]);

  // Colonnes médecins pour la grille des dispos
  const doctorOrderForGrid = useMemo(() => {
    const setIds = new Set<string>();
    for (const p of profiles) setIds.add(p.user_id);
    for (const [u] of targets) setIds.add(u);
    for (const set of avail.values()) for (const u of set) setIds.add(u);
    const ids = Array.from(setIds);
    ids.sort((a, b) => {
      const na = nameMap.get(a) ?? a;
      const nb = nameMap.get(b) ?? b;
      return na.localeCompare(nb, 'fr');
    });
    return ids;
  }, [profiles, targets, avail, nameMap]);

  // Toggle dispo (cellule cliquable)
  async function toggleAvailability(slot_id: string, user_id: string) {
    const current = avail.get(slot_id)?.has(user_id) ?? false;
    const next = !current;

    setAvail((prev) => {
      const m = new Map(prev);
      const s = new Set(m.get(slot_id) ?? new Set());
      if (next) s.add(user_id);
      else s.delete(user_id);
      m.set(slot_id, s);
      return m;
    });

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const res = await fetch('/api/admin/toggle-availability', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ slot_id, user_id, available: next }),
      });
      const json = await res.json();
      if (!res.ok || !json?.ok) throw new Error(json?.error ?? 'Échec mise à jour');
    } catch {
      // revert si erreur
      setAvail((prev) => {
        const m = new Map(prev);
        const s = new Set(m.get(slot_id) ?? new Set());
        if (current) s.add(user_id);
        else s.delete(user_id);
        m.set(slot_id, s);
        return m;
      });
      alert('Impossible de modifier la disponibilité');
    }
  }

  const getName = (uid: string) => nameMap.get(uid) ?? uid;

  return (
    <div className="mx-auto max-w-7xl p-4 space-y-6">
      <h1 className="text-2xl font-bold">Générer le planning</h1>

      <div className="flex flex-col gap-3 md:flex-row md:items-end">
        <div className="flex flex-col">
          <label className="text-sm font-medium mb-1">Période</label>
          <select
            value={periodId}
            onChange={(e) => setPeriodId(e.target.value)}
            className="w-full md:w-auto rounded-lg border px-3 py-2 text-gray-900 bg-white"
          >
            <option value="">Choisir une période…</option>
            {periods.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </div>

        <div className="flex gap-2">
          <button
            onClick={generate}
            disabled={!periodId || loading}
            className="rounded-lg bg-blue-600 text-white px-4 py-2 disabled:opacity-50"
          >
            {loading ? 'Calcul…' : 'Générer'}
          </button>
          <button
            onClick={save}
            disabled={!periodId || !result || saving}
            className="rounded-lg bg-emerald-600 text-white px-4 py-2 disabled:opacity-50"
          >
            {saving ? 'Sauvegarde…' : 'Enregistrer en base'}
          </button>
          <button
            onClick={sendEmails}
            disabled={!periodId || !result || loading}
            className="rounded-lg bg-indigo-600 text-white px-4 py-2 disabled:opacity-50"
          >
            Envoyer le planning aux médecins
          </button>
        </div>
      </div>

      {/* SECTION TOUJOURS VISIBLE : Disponibilités par créneau */}
      {periodId && (
        <div className="space-y-3">
          <div className="flex items-end justify-between">
            <h2 className="text-xl font-bold">Disponibilités par créneau</h2>
            <div className="flex items-center gap-2">
              <label className="text-sm">Mois</label>
              <select
                value={monthFilter}
                onChange={(e) => setMonthFilter(e.target.value)}
                className="rounded border px-2 py-1"
              >
                {monthOptions.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          </div>

          {/* barre de scroll en haut (synchronisée) */}
          <div
            ref={topScrollerRef}
            onScroll={onTopScroll}
            className="overflow-x-auto"
            style={{ height: 16 }}
          >
            <div style={{ width: scrollWidth, height: 1 }} />
          </div>

          {/* tableau scrollable (bas) */}
          <div
            ref={bottomScrollerRef}
            onScroll={onBottomScroll}
            className="overflow-x-auto rounded-lg border"
          >
            <table className="min-w-max text-xs" style={{ backgroundColor: '#000', color: '#fff' }}>
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 px-2 py-2 text-left border-r" style={{ backgroundColor: '#000' }}>
                    Créneau
                  </th>
                  {doctorOrderForGrid.map((uid) => (
                    <th
                      key={uid}
                      className="px-1 py-2 text-center border-b border-l"
                      style={{
                        width: 28,
                        minWidth: 28,
                        maxWidth: 28,
                        writingMode: 'vertical-rl',
                        transform: 'rotate(180deg)',
                        whiteSpace: 'nowrap',
                      }}
                      title={getName(uid)}
                    >
                      {getName(uid)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredSlots.map((s) => {
                  const label = `${formatDateLongFR(s.date)} — ${formatKindRange(s.kind)}`;
                  return (
                    <tr key={s.id}>
                      <td className="sticky left-0 z-10 px-2 py-1 border-t border-r" style={{ backgroundColor: '#000' }}>
                        {label}
                      </td>
                      {doctorOrderForGrid.map((uid) => {
                        const ok = avail.get(s.id)?.has(uid) ?? false;
                        return (
                          <td
                            key={uid}
                            onClick={() => toggleAvailability(s.id, uid)}
                            className="text-center align-middle border-t border-l cursor-pointer select-none hover:bg-white/10"
                            style={{ width: 28, minWidth: 28, maxWidth: 28 }}
                            title={ok ? 'Cliquer pour retirer la dispo' : 'Cliquer pour ajouter la dispo'}
                          >
                            {ok ? <span className="font-bold" style={{ color: '#22c55e' }}>✕</span> : <span> </span>}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-zinc-400">
            Astuce : cliquez sur une case pour (dé)cocher la disponibilité du médecin pour ce créneau.
          </p>
        </div>
      )}

      {/* SECTIONS qui dépendent d’une génération */}
      {result && (
        <div className="space-y-6">
          <div>
            <h2 className="text-xl font-bold">Créneaux sans assignation</h2>
            {result.holes === 0 ? (
              <p className="text-sm text-gray-600">Aucun trou 🎉</p>
            ) : (
              <table className="w-full text-sm mt-2 border">
                <thead>
                  <tr className="bg-red-50">
                    <th className="p-2 text-left font-bold text-red-700">Date</th>
                    <th className="p-2 text-left font-bold text-red-700">Créneau</th>
                    <th className="p-2 text-left font-bold text-red-700"># Candidats</th>
                  </tr>
                </thead>
                <tbody>
                  {result.holes_list.map((h, i) => (
                    <tr key={i} className="border-t">
                      <td className="p-2 font-bold text-red-700">{formatDateLongFR(h.date)}</td>
                      <td className="p-2 font-bold text-red-700">{formatKindRange(h.kind)}</td>
                      <td className="p-2 font-bold text-red-700">{h.candidates}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div>
            <h2 className="text-xl font-bold mb-2">Aperçu des affectations (éditable)</h2>
            <table className="w-full text-sm border">
              <thead>
                <tr className="bg-gray-50">
                  <th className="p-2 text-left text-gray-800 font-semibold">Date</th>
                  <th className="p-2 text-left text-gray-800 font-semibold">Créneau</th>
                  <th className="p-2 text-left text-gray-800 font-semibold">Médecin</th>
                  <th className="p-2 text-left text-gray-800 font-semibold">Score</th>
                </tr>
              </thead>
              <tbody>
                {result.assignments.map((a, i) => {
                  const cands = result.candidates_by_slot?.[a.slot_id] ?? [];
                  const userSel = edited[a.slot_id] ?? a.user_id;
                  return (
                    <tr key={a.slot_id + i} className="border-t">
                      <td className="p-2">{formatDateLongFR(a.date)}</td>
                      <td className="p-2">{formatKindRange(a.kind)}</td>
                      <td className="p-2">
                        {cands.length ? (
                          <select
                            value={userSel}
                            onChange={(e) => setEditedUser(a.slot_id, e.target.value)}
                            className="border rounded px-2 py-1"
                          >
                            {cands.map((c) => (
                              <option key={c.user_id} value={c.user_id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-red-700 font-semibold">— Aucun candidat —</span>
                        )}
                      </td>
                      <td className="p-2 font-mono">{a.score.toFixed(3)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div>
            <h2 className="text-xl font-bold mb-2">Répartition des gardes (après vos modifications)</h2>
            <table className="w-full text-sm border">
              <thead>
                <tr className="bg-gray-50">
                  <th className="p-2 text-left text-gray-800 font-semibold">Médecin</th>
                  <th className="p-2 text-left text-gray-800 font-semibold"># Gardes</th>
                  <th className="p-2 text-left text-gray-800 font-semibold">Target</th>
                  <th className="p-2 text-left text-gray-800 font-semibold"># Dispos</th>
                  <th className="p-2 text-left text-gray-800 font-semibold">Écart</th>
                </tr>
              </thead>
              <tbody>
                {doctorRows.map((r, idx) => (
                  <tr key={idx} className="border-t">
                    <td className="p-2">{r.name}</td>
                    <td className="p-2">{r.assigned}</td>
                    <td className="p-2">{r.targetLabel}</td>
                    <td className="p-2">{r.dispos}</td>
                    <td className="p-2">{r.ecart}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
