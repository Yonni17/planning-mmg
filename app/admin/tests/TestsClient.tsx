// app/admin/tests/TestsClient.tsx
'use client';

import { useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type TestId =
  | 'automation_settings'
  | 'period_effective'
  | 'reminder_targets'
  | 'slots'
  | 'availability_consistency'
  | 'assignments_consistency';

type TestResult = { ok?: boolean; title?: string; details?: any; error?: string };

const ALL_TESTS: { id: TestId; label: string; needsPeriod: boolean }[] = [
  { id: 'automation_settings', label: 'Réglages globaux', needsPeriod: false },
  { id: 'period_effective', label: 'Période — settings effectifs', needsPeriod: true },
  { id: 'reminder_targets', label: 'Cibles de rappel', needsPeriod: true },
  { id: 'slots', label: 'Présence de slots', needsPeriod: true },
  { id: 'availability_consistency', label: 'Disponibilités cohérentes', needsPeriod: true },
  { id: 'assignments_consistency', label: 'Affectations cohérentes', needsPeriod: true },
];

async function withAuthFetch(input: RequestInfo, init: RequestInit = {}) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(input, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: token ? `Bearer ${token}` : '',
      'Content-Type': 'application/json',
    },
    credentials: 'include',
  });
}

export default function TestsClient() {
  const [periodId, setPeriodId] = useState('');
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const [error, setError] = useState<string>('');

  async function runAll() {
    setRunning(true);
    setError('');
    const res: Record<string, TestResult> = {};
    try {
      for (const t of ALL_TESTS) {
        if (t.needsPeriod && !periodId) {
          res[t.id] = { ok: false, title: t.label, error: 'period_id requis' };
          continue;
        }
        const body: any = { test: t.id };
        if (t.needsPeriod) body.period_id = periodId;
        const r = await withAuthFetch('/api/admin/tests', { method: 'POST', body: JSON.stringify(body) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) res[t.id] = { ok: false, title: t.label, error: j?.error || `HTTP ${r.status}` };
        else res[t.id] = { ok: j.ok ?? true, title: j.title || t.label, details: j.details };
      }
      setResults(res);
    } catch (e: any) {
      setError(e?.message || 'Erreur inconnue');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-semibold text-white">Tests & Diagnostics</h1>

      <div className="rounded-xl border border-zinc-700 bg-zinc-800/60 p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm text-zinc-300 mb-1">Période (UUID)</label>
            <input
              value={periodId}
              onChange={(e) => setPeriodId(e.target.value)}
              className="w-full rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2 text-white"
              placeholder="UUID période"
            />
          </div>
          <div className="md:col-span-2 flex items-end">
            <button
              onClick={runAll}
              disabled={running}
              className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
            >
              {running ? 'Analyse…' : 'Lancer les tests'}
            </button>
          </div>
        </div>
        {error && <p className="text-sm text-amber-300">{error}</p>}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {ALL_TESTS.map((t) => {
          const r = results[t.id];
          return (
            <div key={t.id} className="rounded-xl border border-zinc-700 bg-zinc-800/60 p-4">
              <h2 className="text-lg font-semibold text-white mb-2">{t.label}</h2>
              {!r ? (
                <p className="text-sm text-zinc-400">—</p>
              ) : r.error ? (
                <p className="text-sm text-red-300">Erreur : {r.error}</p>
              ) : (
                <pre className="text-xs text-zinc-300 whitespace-pre-wrap break-words">
                  {JSON.stringify(r.details ?? { ok: r.ok }, null, 2)}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
