// app/admin/planning/page.tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type Period = { id: string; label: string };
type Slot = { id: string; date: string; kind: string };
type Assignment = { slot_id: string; user_id: string; display_name?: string; score: number };
type Hole = { slot_id: string; display_date?: string; display_kind?: string; date?: string; kind?: string; candidates: number };

const KIND_LABEL: Record<string, string> = {
  WEEKDAY_20_00: 'Semaine 20–00',
  SAT_12_18: 'Sam 12–18',
  SAT_18_00: 'Sam 18–00',
  SUN_08_14: 'Dim 08–14',
  SUN_14_20: 'Dim 14–20',
  SUN_20_24: 'Dim 20–24',
};

export default function AdminPlanningPage() {
  const [periods, setPeriods] = useState<Period[]>([]);
  const [periodId, setPeriodId] = useState<string>('');
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    holes: number;
    total_score: number;
    assignments: Assignment[];
    runs?: { seed: number; total_score: number; holes: number }[];
    holes_list?: Hole[];
    debug?: any[];
  } | null>(null);

  // Params
  const [seeds, setSeeds] = useState(100);
  const [penaltyOverTarget, setPenaltyOverTarget] = useState(2.0);
  const [bonusBias, setBonusBias] = useState(1.0);
  const [fairnessGamma, setFairnessGamma] = useState(0.15);
  const [reservePenalty, setReservePenalty] = useState(6.0);
  const [hardCap, setHardCap] = useState(true);
  const [gammaMax, setGammaMax] = useState(0.75);
  const [preferEdgeBonus, setPreferEdgeBonus] = useState(0.75);
  const [neutralEdgePenalty, setNeutralEdgePenalty] = useState(0.5);
  const [probeDate, setProbeDate] = useState<string>('2025-10-01'); // DEBUG date

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('periods')
        .select('id,label')
        .order('open_at', { ascending: false });
      setPeriods((data ?? []) as any);
    })();
  }, []);

  useEffect(() => {
    if (!periodId) return;
    (async () => {
      const { data } = await supabase
        .from('slots')
        .select('id,date,kind')
        .eq('period_id', periodId)
        .order('start_ts', { ascending: true });
      setSlots((data ?? []) as any);
    })();
  }, [periodId]);

  const slotsById = useMemo(() => {
    const m = new Map<string, Slot>();
    for (const s of slots) m.set(s.id, s);
    return m;
  }, [slots]);

  async function run(dry: boolean) {
    if (!periodId) return;
    setLoading(true);
    setResult(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      const res = await fetch('/api/admin/generate-planning', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          period_id: periodId,
          seeds,
          penalty_over_target: penaltyOverTarget,
          bonus_bias: bonusBias,
          fairness_gamma: fairnessGamma,
          reserve_penalty: reservePenalty,
          hard_cap: hardCap,
          gamma_max: gammaMax,
          prefer_edge_bonus: preferEdgeBonus,
          neutral_edge_penalty: neutralEdgePenalty,
          dry_run: dry,
          // DEBUG
          debug_probe_date: dry ? (probeDate || undefined) : undefined,
        }),
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Erreur serveur');

      if (dry) {
        setResult({
          holes: json.holes,
          total_score: json.total_score,
          assignments: json.assignments,
          runs: json.runs,
          holes_list: json.holes_list,
          debug: json.debug,
        });
      } else {
        const { data: aRows } = await supabase
          .from('assignments')
          .select('slot_id,user_id,score')
          .eq('period_id', periodId);

        const ids = Array.from(new Set((aRows ?? []).map(r => r.user_id)));
        let nameMap = new Map<string, string>();
        if (ids.length) {
          const { data: profs } = await supabase
            .from('profiles')
            .select('user_id, full_name')
            .in('user_id', ids);
          for (const p of profs ?? []) nameMap.set(p.user_id, p.full_name ?? p.user_id);
        }

        setResult({
          holes: json.holes,
          total_score: json.total_score,
          assignments: (aRows ?? []).map(r => ({
            slot_id: r.slot_id,
            user_id: r.user_id,
            display_name: nameMap.get(r.user_id) ?? r.user_id,
            score: (r as any).score ?? 0,
          })),
        });
      }
    } catch (e: any) {
      alert(e.message);
    } finally {
      setLoading(false);
    }
  }

  // Dé-dup visuel par slot_id (sécurité)
  const uniqueAssignments = useMemo(() => {
    const seen = new Set<string>();
    const out: Assignment[] = [];
    for (const a of result?.assignments ?? []) {
      if (!seen.has(a.slot_id)) {
        seen.add(a.slot_id);
        out.push(a);
      }
    }
    return out;
  }, [result]);

  // Répartition par médecin (nom + nb de gardes)
  const perDoctor = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of uniqueAssignments) {
      const name = a.display_name ?? a.user_id;
      map.set(name, (map.get(name) ?? 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [uniqueAssignments]);

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-bold">Génération automatique du planning</h1>

      <div className="grid lg:grid-cols-2 gap-5">
        <div className="p-4 rounded-2xl border space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2">Période</label>
            <select
              className="w-full rounded-lg border px-3 py-2"
              value={periodId}
              onChange={e => setPeriodId(e.target.value)}
            >
              <option value="">— choisir —</option>
              {periods.map(p => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </div>

          <fieldset className="grid sm:grid-cols-2 gap-4">
            <ParamNumber label="Seeds" value={seeds} setValue={setSeeds} min={1}
              hint="Nombre d'essais aléatoires. On garde le meilleur (0 trou puis meilleur score)." />
            <ParamNumber label="Penalty over target" value={penaltyOverTarget} setValue={setPenaltyOverTarget} step={0.1}
              hint="Pénalise le dépassement de la cible (1..4)." />
            <ParamNumber label="Bonus bias" value={bonusBias} setValue={setBonusBias} step={0.1}
              hint="Poids des préférences docteur (+1 favorise / -1 évite)." />
            <ParamNumber label="Fairness γ" value={fairnessGamma} setValue={setFairnessGamma} step={0.05}
              hint="Évite d'enchaîner le même médecin." />
            <ParamNumber label="Réserve (pénalité)" value={reservePenalty} setValue={setReservePenalty} step={0.5}
              hint="Protège les slots où un médecin est le seul dispo ailleurs." />
            <ParamNumber label="Équité Max (γmax)" value={gammaMax} setValue={setGammaMax} step={0.05}
              hint="Équité entre les médecins 'max'." />
            <ParamNumber label="Favoriser les +1" value={preferEdgeBonus} setValue={setPreferEdgeBonus} step={0.05}
              hint="Si +1 existe, bonus au +1." />
            <ParamNumber label="Malus indifférent (0)" value={neutralEdgePenalty} setValue={setNeutralEdgePenalty} step={0.05}
              hint="Si +1 existe, on évite de donner à un 0." />
          </fieldset>

          <ParamText
            label="Debug — date (YYYY-MM-DD)"
            value={probeDate}
            setValue={setProbeDate}
            hint="Ex: 2025-10-01. L’API renverra candidats & scores pour cette date (dry-run uniquement)."
          />

          <div className="flex items-center gap-2">
            <input id="hardcap" type="checkbox" className="h-4 w-4"
              checked={hardCap} onChange={e => setHardCap(e.target.checked)} />
            <label htmlFor="hardcap" className="text-sm">
              Respect strict des cibles. Si aucun éligible, on dépasse pour éviter un trou.
            </label>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              className="px-4 py-2 rounded-xl bg-zinc-900 text-white disabled:opacity-60"
              disabled={!periodId || loading}
              onClick={() => run(true)}
            >
              {loading ? '...' : 'Dry-run (simulation)'}
            </button>
            <button
              className="px-4 py-2 rounded-xl bg-emerald-600 text-white disabled:opacity-60"
              disabled={!periodId || loading}
              onClick={() => run(false)}
            >
              {loading ? '...' : 'Générer & enregistrer'}
            </button>
          </div>
        </div>

        {/* Résumé */}
        <div className="p-4 rounded-2xl border">
          <div className="text-sm text-zinc-500">Résumé</div>
          {result ? (
            <ul className="mt-2 space-y-1">
              <li><b>Trous</b> : {result.holes}</li>
              <li><b>Score total</b> : {result.total_score?.toFixed?.(3) ?? '—'}</li>
              <li><b>Assignations</b> : {uniqueAssignments.length}</li>
            </ul>
          ) : (
            <div className="text-zinc-500 mt-2">Lance une simulation pour voir un aperçu.</div>
          )}
        </div>
      </div>

      {/* TOP 10 seeds */}
      {result?.runs && (
        <div className="p-4 rounded-2xl border">
          <h2 className="font-semibold mb-2">TOP 10 des seeds (dry-run)</h2>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="py-2 pr-4">Seed</th>
                  <th className="py-2 pr-4">Score total</th>
                  <th className="py-2 pr-4">Trous</th>
                </tr>
              </thead>
              <tbody>
                {result.runs.map((r, i) => (
                  <tr key={i} className="border-b">
                    <td className="py-1 pr-4">{r.seed}</td>
                    <td className="py-1 pr-4">{r.total_score}</td>
                    <td className="py-1 pr-4">{r.holes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-zinc-500 mt-2">
            Classement : moins de trous, puis meilleur score.
          </p>
        </div>
      )}

      {/* Trous détectés (dry-run) */}
      {result?.holes_list && result.holes_list.length > 0 && (
        <div className="p-4 rounded-2xl border">
          <h2 className="font-semibold mb-2">Trous détectés (simulation)</h2>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="py-2 pr-4">Date</th>
                  <th className="py-2 pr-4">Créneau</th>
                  <th className="py-2 pr-4">Candidats trouvés</th>
                </tr>
              </thead>
              <tbody>
                {result.holes_list.map((h, i) => {
                  const date = h.display_date ?? (h as any).date ?? '—';
                  const kind = h.display_kind ?? (h as any).kind ?? '';
                  return (
                    <tr key={i} className="border-b">
                      <td className="py-1 pr-4">{date}</td>
                      <td className="py-1 pr-4">{KIND_LABEL[kind] ?? kind}</td>
                      <td className="py-1 pr-4">{h.candidates}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-zinc-500 mt-2">
            S’il y a des candidats & malgré tout un trou, l’API force désormais un fallback (meilleur candidat).
          </p>
        </div>
      )}

      {/* Répartition par médecin (nb de gardes) */}
      {uniqueAssignments.length > 0 && (
        <div className="p-4 rounded-2xl border">
          <h2 className="font-semibold mb-2">Répartition par médecin</h2>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="py-2 pr-4">Médecin</th>
                  <th className="py-2 pr-4">Nb gardes</th>
                </tr>
              </thead>
              <tbody>
                {perDoctor.map(([name, count]) => (
                  <tr key={name} className="border-b">
                    <td className="py-1 pr-4">{name}</td>
                    <td className="py-1 pr-4">{count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Assignations */}
      {result && (
        <div className="p-4 rounded-2xl border">
          <h2 className="font-semibold mb-3">Aperçu des affectations</h2>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="py-2 pr-4">Date</th>
                  <th className="py-2 pr-4">Créneau</th>
                  <th className="py-2 pr-4">Médecin</th>
                  <th className="py-2 pr-4">Score</th>
                </tr>
              </thead>
              <tbody>
                {uniqueAssignments.map((a, i) => {
                  const s = slotsById.get(a.slot_id);
                  return (
                    <tr key={i} className="border-b">
                      <td className="py-1 pr-4">{s?.date ?? '—'}</td>
                      <td className="py-1 pr-4">{KIND_LABEL[s?.kind ?? ''] ?? s?.kind ?? '—'}</td>
                      <td className="py-1 pr-4">{a.display_name ?? a.user_id}</td>
                      <td className="py-1 pr-4">{a.score?.toFixed?.(3) ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Debug brut (optionnel) */}
          {result.debug && result.debug.length > 0 && (
            <div className="mt-6">
              <h3 className="font-semibold mb-2">Debug slot {probeDate}</h3>
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead>
                    <tr className="text-left border-b">
                      <th className="py-2 pr-3">Phase</th>
                      <th className="py-2 pr-3">Détails</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.debug.map((row: any, i: number) => (
                      <tr key={i} className="border-b align-top">
                        <td className="py-1 pr-3">{row.phase}</td>
                        <td className="py-1 pr-3">
                          <pre className="whitespace-pre-wrap">{JSON.stringify(row, null, 2)}</pre>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-zinc-500 mt-2">Les lignes “score” listent chaque candidat avec ses composantes.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ParamNumber({
  label,
  value,
  setValue,
  hint,
  step = 1,
  min,
}: {
  label: string;
  value: number;
  setValue: (n: number) => void;
  hint?: string;
  step?: number;
  min?: number;
}) {
  return (
    <div>
      <label className="text-sm font-medium">{label}</label>
      <input
        type="number"
        className="w-full border rounded px-2 py-1 mt-1"
        value={value}
        onChange={e => setValue(+e.target.value)}
        step={step}
        {...(min !== undefined ? { min } : {})}
      />
      {hint && <p className="text-xs text-zinc-500 mt-1">{hint}</p>}
    </div>
  );
}

function ParamText({
  label, value, setValue, hint,
}: { label: string; value: string; setValue: (s: string) => void; hint?: string }) {
  return (
    <div>
      <label className="text-sm font-medium">{label}</label>
      <input
        type="text"
        className="w-full border rounded px-2 py-1 mt-1"
        value={value}
        onChange={e => setValue(e.target.value)}
      />
      {hint && <p className="text-xs text-zinc-500 mt-1">{hint}</p>}
    </div>
  );
}
