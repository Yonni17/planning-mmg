'use client';

import { useMemo, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type DiagResponse = {
  ok: true;
  period_id: string;
  period_label?: string;
  effective: {
    avail_open_at?: string | null;
    avail_deadline?: string | null;
    weekly_reminder: boolean;
    extra_reminder_hours: number[];
    planning_generate_before_days: number;
    tz: string;
    in_window: boolean;
    now: string;
    hours_left?: number | null;
    due_kinds: Array<'weekly'|'deadline_48'|'deadline_24'|'deadline_1'>;
  };
  counts: {
    slots?: number;
    doctors?: number;
    targets?: number;
    locked?: number;
    validated?: number;
    opted_out?: number;
  };
  targets_preview: Array<{ user_id: string; email?: string | null; full_name?: string | null }>;
};

type DiagError = { error: string };

export default function TestsClient() {
  const [periodId, setPeriodId] = useState('');
  const [nowISO, setNowISO] = useState<string>(() => new Date().toISOString().slice(0,16));
  const [limit, setLimit] = useState(50);
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<DiagResponse | null>(null);
  const [errMsg, setErrMsg] = useState<string>('');

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

  async function runDiagnostics() {
    setLoading(true);
    setErrMsg('');
    setRes(null);
    try {
      const body = {
        period_id: periodId.trim(),
        nowISO: toISO(nowISO),
        limit,
      };
      const r = await withAuthFetch('/api/admin/diagnostics', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setRes(j as DiagResponse);
    } catch (e: any) {
      setErrMsg(e.message || 'Erreur inconnue');
    } finally {
      setLoading(false);
    }
  }

  const dueText = useMemo(() => {
    if (!res) return '';
    if (!res.effective.due_kinds.length) return 'Aucun rappel dû à cet instant.';
    return `Rappels dus maintenant: ${res.effective.due_kinds.join(', ')}`;
  }, [res]);

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
          <div>
            <label className="block text-sm text-zinc-300 mb-1">Date/heure de test (locale)</label>
            <input
              type="datetime-local"
              value={nowISO}
              onChange={(e) => setNowISO(e.target.value)}
              className="w-full rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2 text-white"
            />
          </div>
          <div>
            <label className="block text-sm text-zinc-300 mb-1">Aperçu destinataires (limite)</label>
            <input
              type="number"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value || 0))}
              className="w-full rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2 text-white"
              min={1}
              max={500}
            />
          </div>
        </div>

        <button
          onClick={runDiagnostics}
          disabled={loading || !periodId}
          className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
        >
          {loading ? 'Analyse…' : 'Lancer les checks'}
        </button>

        {errMsg && <p className="text-sm text-amber-300">{errMsg}</p>}
      </div>

      {res && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-xl border border-zinc-700 bg-zinc-800/60 p-4">
            <h2 className="text-lg font-semibold text-white mb-2">Réglages effectifs</h2>
            <ul className="text-sm text-zinc-300 space-y-1">
              <li><b>Période :</b> {res.period_label || res.period_id}</li>
              <li><b>Ouverture :</b> {fmt(res.effective.avail_open_at)}</li>
              <li><b>Deadline :</b> {fmt(res.effective.avail_deadline)}</li>
              <li><b>Fenêtre active :</b> {res.effective.in_window ? 'OUI' : 'NON'}</li>
              <li><b>Heures restantes :</b> {res.effective.hours_left ?? '—'}</li>
              <li><b>Rappel hebdo :</b> {res.effective.weekly_reminder ? 'actif' : 'inactif'}</li>
              <li><b>Rappels -h :</b> {res.effective.extra_reminder_hours.join(', ') || '—'}</li>
              <li><b>Fuseau :</b> {res.effective.tz}</li>
              <li className="mt-2 text-emerald-300">{dueText}</li>
              <li className="text-zinc-400 text-xs"><i>Horodatage de test :</i> {fmt(res.effective.now)}</li>
            </ul>
          </div>

          <div className="rounded-xl border border-zinc-700 bg-zinc-800/60 p-4">
            <h2 className="text-lg font-semibold text-white mb-2">Compteurs</h2>
            <ul className="text-sm text-zinc-300 space-y-1">
              <li><b>Slots :</b> {res.counts.slots ?? '—'}</li>
              <li><b>Médecins :</b> {res.counts.doctors ?? '—'}</li>
              <li><b>Cibles (non verrouillés & non validés & pas opt-out) :</b> {res.counts.targets ?? 0}</li>
              <li className="text-zinc-400 text-xs">
                verrouillés: {res.counts.locked ?? 0} · validés: {res.counts.validated ?? 0} · opt-out: {res.counts.opted_out ?? 0}
              </li>
            </ul>
          </div>

          <div className="rounded-xl border border-zinc-700 bg-zinc-800/60 p-4 lg:col-span-2">
            <h2 className="text-lg font-semibold text-white mb-2">Aperçu des destinataires</h2>
            {res.targets_preview.length === 0 ? (
              <p className="text-sm text-zinc-400">Aucun destinataire ciblé aux conditions actuelles.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-zinc-400">
                    <th className="py-2">Nom</th>
                    <th className="py-2">Email</th>
                    <th className="py-2">User ID</th>
                  </tr>
                </thead>
                <tbody>
                  {res.targets_preview.map((t) => (
                    <tr key={t.user_id} className="border-t border-zinc-700">
                      <td className="py-2 text-zinc-200">{t.full_name || '—'}</td>
                      <td className="py-2 text-zinc-300">{t.email || '—'}</td>
                      <td className="py-2 text-zinc-500">{t.user_id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function toISO(local: string | undefined) {
  if (!local) return undefined;
  const d = new Date(local);
  if (isNaN(d.getTime())) return undefined;
  return d.toISOString();
}
function fmt(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
}
