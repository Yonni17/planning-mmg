'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';

type Period = { id: string; label: string };
type SlotRow = { id: string; date: string; kind: string; start_ts?: string };

type UsersIndexEntry = {
  name: string;              // "Prénom Nom" (ou user_id fallback)
  target_level: number | null;
  avail_count: number;       // nombre de dispos déclarées
  assigned_count?: number;   // nombre de gardes attribuées (après POST)
};

type AvailabilityBySlot = Record<
  string,
  { date: string; kind: string; candidates: { user_id: string; name: string }[] }
>;

type AvailabilitySummary = {
  availability_by_slot: AvailabilityBySlot;
  users_index: Record<string, UsersIndexEntry>;
};

type AssignmentView = {
  slot_id: string;
  user_id: string;
  display_name: string;
  date: string | null;
  kind: string | null;
  score: number;
};

export default function AdminPlanningPage() {
  const [periods, setPeriods] = useState<Period[]>([]);
  const [periodId, setPeriodId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  // Données “base” visibles tout le temps
  const [slots, setSlots] = useState<SlotRow[]>([]);
  const [availabilitySummary, setAvailabilitySummary] = useState<AvailabilitySummary | null>(null);

  // Données après POST (simulation/génération)
  const [assignments, setAssignments] = useState<AssignmentView[] | null>(null);
  const [candidatesBySlot, setCandidatesBySlot] = useState<Record<string, { user_id: string; name: string }[]> | null>(null);
  const [usersIndex, setUsersIndex] = useState<Record<string, UsersIndexEntry>>({});

  // -------- Helpers --------
  const nameOf = (uid: string) =>
    usersIndex[uid]?.name ??
    availabilitySummary?.users_index?.[uid]?.name ??
    uid;

  const kindLabel = (k: string) => {
    switch (k) {
      case 'WEEKDAY_20_00': return '20:00–00:00 (Semaine)';
      case 'SAT_12_18':     return '12:00–18:00 (Sam)';
      case 'SAT_18_00':     return '18:00–00:00 (Sam)';
      case 'SUN_08_14':     return '08:00–14:00 (Dim)';
      case 'SUN_14_20':     return '14:00–20:00 (Dim)';
      case 'SUN_20_24':     return '20:00–00:00 (Dim)';
      default: return k;
    }
  };

  // -------- Init: périodes + chargement par défaut --------
  useEffect(() => {
    (async () => {
      setLoading(true);
      setMsg(null);
      try {
        const { data: periodsData, error: perr } = await supabase
          .from('periods')
          .select('id,label')
          .order('open_at', { ascending: false });
        if (perr) throw perr;

        const list = periodsData || [];
        setPeriods(list);
        const defId = list[0]?.id || '';
        setPeriodId(defId);

        if (defId) {
          await loadBase(defId);    // <— GET pour “Disponibilités par créneau” immédiatement
        }
      } catch (e: any) {
        setMsg(`❌ ${e.message ?? 'Erreur de chargement périodes'}`);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // -------- Charge la base (GET) : slots + availability_summary --------
  const loadBase = async (pid: string) => {
    setMsg(null);
    setAssignments(null);       // reset vue “Aperçu des affectations”
    setCandidatesBySlot(null);

    try {
      // 1) Slots pour l’ordre/affichage
      const { data: slotsData, error: sErr } = await supabase
        .from('slots')
        .select('id, date, kind, start_ts')
        .eq('period_id', pid)
        .order('start_ts', { ascending: true });
      if (sErr) throw sErr;
      setSlots((slotsData ?? []) as SlotRow[]);

      // 2) Résumé des dispos (avec noms) — fonctionne sans génération
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const res = await fetch(`/api/admin/generate-planning?period_id=${encodeURIComponent(pid)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);

      const availability: AvailabilitySummary = {
        availability_by_slot: json.availability_by_slot || {},
        users_index: json.users_index || {},
      };

      setAvailabilitySummary(availability);
      setUsersIndex(availability.users_index || {});
    } catch (e: any) {
      setMsg(`❌ ${e.message ?? 'Erreur chargement dispos'}`);
    }
  };

  // -------- Simulation / Génération (POST) --------
  const runGeneration = async (dry_run = true) => {
    if (!periodId) return;
    setMsg(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const res = await fetch('/api/admin/generate-planning', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ period_id: periodId, include_candidates: true, dry_run }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);

      // Assignations enrichies (avec display_name)
      setAssignments(j.assignments || null);

      // Candidats par slot (avec noms)
      setCandidatesBySlot(j.candidates_by_slot || null);

      // Index utilisateurs mis à jour (avec assigned_count si non-dry)
      setUsersIndex(j.users_index || usersIndex);

      // Toujours garder la table “disponibilités par créneau” visible
      if (j.availability_summary) {
        setAvailabilitySummary(j.availability_summary);
        // usersIndex déjà synchronisé au-dessus
      }

      setMsg(dry_run ? '✅ Simulation terminée' : '✅ Planning enregistré');
    } catch (e: any) {
      setMsg(`❌ ${e.message ?? 'Erreur génération'}`);
    }
  };

  const availabilityToDisplay = useMemo(() => {
    // Si on a POST, on préfère candidatesBySlot (qui vient aussi du serveur) ;
    // sinon on affiche la summary GET (toujours visible au démarrage).
    if (candidatesBySlot) return candidatesBySlot;
    return availabilitySummary?.availability_by_slot || {};
  }, [candidatesBySlot, availabilitySummary]);

  // -------- RENDER --------
  return (
    <div className="mx-auto max-w-7xl p-6 space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold">Planning & génération</h1>

        <div className="ml-auto flex items-center gap-2">
          <select
            className="border rounded px-3 py-1.5 bg-white text-gray-900 dark:bg-zinc-900 dark:text-zinc-100 dark:border-zinc-700"
            value={periodId}
            onChange={async (e) => {
              const v = e.target.value;
              setPeriodId(v);
              setAssignments(null);
              setCandidatesBySlot(null);
              await loadBase(v);
            }}
          >
            {periods.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>

          <button
            onClick={() => runGeneration(true)}
            className="px-3 py-1.5 rounded-lg border border-blue-500 text-white bg-blue-600 hover:bg-blue-500"
          >
            Simuler la génération
          </button>
          <button
            onClick={() => runGeneration(false)}
            className="px-3 py-1.5 rounded-lg border border-emerald-600 text-white bg-emerald-600 hover:bg-emerald-500"
          >
            Enregistrer le planning
          </button>
        </div>
      </div>

      {msg && (
        <div className={`p-3 rounded border ${msg.startsWith('❌')
          ? 'border-red-700 bg-red-900/30 text-red-200'
          : 'border-emerald-700 bg-emerald-900/30 text-emerald-200'
          }`}>
          {msg}
        </div>
      )}

      {/* Aperçu des affectations (éditable) */}
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Aperçu des affectations (éditable)</h2>

        <div className="overflow-x-auto rounded-xl border border-zinc-700">
          <table className="min-w-[900px] w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-200">
              <tr>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Créneau</th>
                <th className="px-3 py-2 text-left">Attribué à</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800 bg-zinc-900/30 text-zinc-100">
              {loading ? (
                <tr><td colSpan={3} className="px-3 py-6 text-center text-zinc-400">Chargement…</td></tr>
              ) : (assignments?.length ?? 0) === 0 ? (
                <tr><td colSpan={3} className="px-3 py-6 text-center text-zinc-400">Aucune affectation pour le moment (lance une simulation).</td></tr>
              ) : (assignments || []).map((a) => (
                <tr key={a.slot_id}>
                  <td className="px-3 py-2">{a.date ?? '—'}</td>
                  <td className="px-3 py-2">{a.kind ? kindLabel(a.kind) : '—'}</td>
                  <td className="px-3 py-2">{a.display_name || nameOf(a.user_id)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Disponibilités par créneau — visible dès le chargement (GET) */}
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Disponibilités par créneau</h2>
        <div className="overflow-x-auto rounded-xl border border-zinc-700">
          <table className="min-w-[1200px] w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-200">
              <tr>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Créneau</th>
                <th className="px-3 py-2 text-left">Candidats (noms)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800 bg-zinc-900/30 text-zinc-100">
              {loading ? (
                <tr><td colSpan={3} className="px-3 py-6 text-center text-zinc-400">Chargement…</td></tr>
              ) : slots.length === 0 ? (
                <tr><td colSpan={3} className="px-3 py-6 text-center text-zinc-400">Aucun créneau pour cette période.</td></tr>
              ) : slots.map((s) => {
                const rec = availabilityToDisplay[s.id]; // peut venir de GET ou POST
                const names = (rec?.candidates || [])
                  .map(c => c.name || nameOf(c.user_id))
                  .join(', ');
                return (
                  <tr key={s.id}>
                    <td className="px-3 py-2">{s.date}</td>
                    <td className="px-3 py-2">{kindLabel(s.kind)}</td>
                    <td className="px-3 py-2">
                      <div className="whitespace-nowrap">{names || <span className="text-zinc-400">—</span>}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-zinc-400">
          Astuce : cette table est alimentée dès l’ouverture de la page (GET /api/admin/generate-planning).  
          Après une simulation, elle se met aussi à jour avec les mêmes noms (source POST).
        </p>
      </div>

      {/* Récap utilisateurs */}
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Répartition par médecin</h2>
        <div className="overflow-x-auto rounded-xl border border-zinc-700">
          <table className="min-w-[800px] w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-200">
              <tr>
                <th className="px-3 py-2 text-left">Médecin</th>
                <th className="px-3 py-2 text-left">Cible (target)</th>
                <th className="px-3 py-2 text-left">Disponibilités déclarées</th>
                <th className="px-3 py-2 text-left">Affectations</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800 bg-zinc-900/30 text-zinc-100">
              {Object.keys(usersIndex).length === 0 ? (
                <tr><td colSpan={4} className="px-3 py-6 text-center text-zinc-400">Aucun utilisateur visible sur cette période.</td></tr>
              ) : Object.entries(usersIndex)
                .sort((a, b) => a[1].name.localeCompare(b[1].name, 'fr'))
                .map(([uid, info]) => (
                <tr key={uid}>
                  <td className="px-3 py-2">{info.name || uid}</td>
                  <td className="px-3 py-2">{info.target_level ?? '—'}</td>
                  <td className="px-3 py-2">{info.avail_count ?? 0}</td>
                  <td className="px-3 py-2">{info.assigned_count ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
