'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

type Period = { id: string; label: string };

type TestId =
  | 'slots_exist'
  | 'availability_consistency'
  | 'targets_presence'
  | 'assignments_coverage'
  | 'automation_settings'
  | 'doctor_months_status';

type TestResult = {
  ok: boolean;
  title: string;
  details?: any;
  error?: string;
};

const TESTS: { id: TestId; title: string; needsPeriod: boolean; hint?: string }[] = [
  { id: 'slots_exist', title: 'Slots présents pour la période', needsPeriod: true },
  { id: 'availability_consistency', title: 'Disponibilités (cohérence & volume)', needsPeriod: true, hint: 'Vérifie candidats / slot / utilisateurs distincts' },
  { id: 'targets_presence', title: 'Cibles (preferences_period)', needsPeriod: true, hint: 'Vérifie présence de target_level pour les utilisateurs' },
  { id: 'assignments_coverage', title: 'Assignations (couverture)', needsPeriod: true, hint: 'Vérifie trous / doublons par slot' },
  { id: 'automation_settings', title: 'Réglages d’automatisation (globaux)', needsPeriod: false },
  { id: 'doctor_months_status', title: 'Statut des mois (doctor_period_months)', needsPeriod: true, hint: 'Locked/Opted-out par mois' },
];

export default function TestsAdminPage() {
  const [periods, setPeriods] = useState<Period[]>([]);
  const [periodId, setPeriodId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, TestResult | null>>({});
  const [runningAll, setRunningAll] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setMsg(null);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setMsg('Auth session missing!');
        setLoading(false);
        return;
      }
      const { data: periodsData, error: pErr } = await supabase
        .from('periods')
        .select('id,label')
        .order('open_at', { ascending: false });
      if (pErr) {
        setMsg(`Erreur périodes: ${pErr.message}`);
        setLoading(false);
        return;
      }
      const list = periodsData ?? [];
      setPeriods(list);
      setPeriodId(list[0]?.id ?? '');
      setLoading(false);
    })();
  }, []);

  const runOne = async (id: TestId) => {
    setMsg(null);
    setRunning(prev => ({ ...prev, [id]: true }));
    setResults(prev => ({ ...prev, [id]: null }));
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      const res = await fetch('/api/admin/tests', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ test: id, period_id: periodId || null }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? 'Erreur test');
      setResults(prev => ({ ...prev, [id]: json as TestResult }));
    } catch (e: any) {
      setResults(prev => ({
        ...prev,
        [id]: { ok: false, title: id, error: e.message },
      }));
    } finally {
      setRunning(prev => ({ ...prev, [id]: false }));
    }
  };
const TESTS: { id: TestId; title: string; needsPeriod: boolean; hint?: string }[] = [
  { id: 'slots_exist', title: 'Slots présents pour la période', needsPeriod: true },
  { id: 'availability_consistency', title: 'Disponibilités (cohérence & volume)', needsPeriod: true, hint: 'Vérifie candidats / slot / utilisateurs distincts' },
  { id: 'targets_presence', title: 'Cibles (preferences_period)', needsPeriod: true, hint: 'Vérifie présence de target_level pour les utilisateurs' },
  { id: 'assignments_coverage', title: 'Assignations (couverture)', needsPeriod: true, hint: 'Vérifie trous / doublons par slot' },
  { id: 'automation_settings', title: 'Réglages d’automatisation (globaux)', needsPeriod: false },

  // ↓ nouveaux scénarios mail (dry-run)
  { id: 'mail_opening', title: 'Mail — Ouverture des disponibilités', needsPeriod: true, hint: 'Destinataires au moment de l’ouverture' },
  { id: 'mail_weekly_reminder', title: 'Mail — Rappel hebdomadaire', needsPeriod: true, hint: 'Entre ouverture et deadline, si non validé' },
  { id: 'mail_deadline_extra', title: 'Mail — Rappels 48/24/1h', needsPeriod: true, hint: 'Autour de la deadline' },
  { id: 'mail_planning_ready', title: 'Mail — Planning validé & prêt', needsPeriod: true, hint: 'Docteurs ayant des gardes' },

  { id: 'doctor_months_status', title: 'Statut mois — doctor_period_months', needsPeriod: true, hint: 'Locked / Opted-out par mois' },
];

  const runAll = async () => {
    setRunningAll(true);
    // reset
    const clean: Record<string, TestResult | null> = {};
    TESTS.forEach(t => clean[t.id] = null);
    setResults(clean);
    try {
      for (const t of TESTS) {
        if (t.needsPeriod && !periodId) continue;
        await runOne(t.id);
      }
    } finally {
      setRunningAll(false);
    }
  };

  const Badge = ({ ok }: { ok: boolean }) => (
    <span className={`px-2 py-0.5 rounded text-xs ${ok ? 'bg-emerald-600/20 text-emerald-300 border border-emerald-700/40' : 'bg-red-600/20 text-red-200 border border-red-800/40'}`}>
      {ok ? 'OK' : 'FAIL'}
    </span>
  );

  return (
    <div className="mx-auto max-w-6xl p-4 space-y-6">
      <h1 className="text-2xl font-bold text-white">Tests & Diagnostics</h1>

      {/* Sélecteur période */}
      <div className="flex items-center gap-3">
        <label className="text-sm text-zinc-300">Période</label>
        <select
          className="border border-zinc-700 rounded bg-zinc-900 text-zinc-100 px-2 py-1"
          value={periodId}
          onChange={(e) => setPeriodId(e.target.value)}
        >
          <option value="">— choisir —</option>
          {periods.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>

        <button
          onClick={runAll}
          disabled={runningAll || loading}
          className="ml-auto rounded-lg bg-blue-600 text-white px-4 py-2 disabled:opacity-50"
        >
          {runningAll ? 'Exécution…' : 'Tout lancer'}
        </button>
      </div>

      {msg && (
        <div className="p-3 rounded-lg border border-red-800 bg-red-950 text-red-200">
          {msg}
        </div>
      )}

      {loading && <div className="text-zinc-400">Chargement…</div>}

      <div className="grid md:grid-cols-2 gap-4">
        {TESTS.map(t => {
          const r = results[t.id] || null;
          const disabled = running[t.id] || (t.needsPeriod && !periodId);
          return (
            <div key={t.id} className="rounded-xl border border-zinc-700 bg-zinc-900/60 p-4 space-y-2">
              <div className="flex items-center justify-between">
                <h2 className="text-white font-semibold">{t.title}</h2>
                <div className="flex items-center gap-2">
                  {r && <Badge ok={!!r.ok} />}
                  <button
                    onClick={() => runOne(t.id)}
                    disabled={disabled}
                    className="rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-100 text-sm px-3 py-1.5 disabled:opacity-50"
                  >
                    {running[t.id] ? '…' : 'Lancer'}
                  </button>
                </div>
              </div>
              {!!t.hint && <div className="text-xs text-zinc-400">{t.hint}</div>}
              {r && (
                <pre className="mt-2 text-xs text-zinc-300 bg-black/30 border border-zinc-800 rounded p-2 overflow-x-auto">
{JSON.stringify(r, null, 2)}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
