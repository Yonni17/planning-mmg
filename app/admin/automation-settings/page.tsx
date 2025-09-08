'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

// ---- Supabase client (client-side) ----
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type Settings = {
  period_id: string | null;
  avail_open_at: string | null;
  avail_deadline: string | null;
  weekly_reminder: boolean;
  extra_reminder_hours: number[];
  planning_generate_before_days: number;
  lock_assignments: boolean;
  slots_generate_before_days?: number;
  avail_deadline_before_days?: number;
};

type ApiError = { error?: string };

type PeriodRow = {
  id: string;
  label: string;
  open_at: string;
  close_at: string;
};

export default function AutomationSettingsPage() {
  const [periodId, setPeriodId] = useState<string>('');
  const [settings, setSettings] = useState<Settings>({
    period_id: null,
    avail_open_at: null,
    avail_deadline: null,
    weekly_reminder: true,
    extra_reminder_hours: [48, 24, 1],
    planning_generate_before_days: 21,
    lock_assignments: false,
  });

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string>('');

  // --- nouveautés : liste des périodes pour ne plus taper l'UUID ---
  const [periods, setPeriods] = useState<PeriodRow[]>([]);
  const [periodsLoading, setPeriodsLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        setPeriodsLoading(true);
        const { data, error } = await supabase
          .from('periods')
          .select('id,label,open_at,close_at')
          .order('open_at', { ascending: false })
          .limit(30);

        if (!error && Array.isArray(data)) setPeriods(data as PeriodRow[]);
      } finally {
        setPeriodsLoading(false);
      }
    })();
  }, []);

  // fetch avec token admin
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

  async function loadSettings() {
    if (!periodId) {
      setMsg('Sélectionne une période pour charger ses overrides / effectifs.');
      return;
    }
    setLoading(true);
    setMsg('');
    try {
      const url = `/api/admin/automation-settings?period_id=${encodeURIComponent(periodId)}`;
      const res = await withAuthFetch(url);
      if (!res.ok) {
        let text = `GET ${res.status}`;
        try {
          const j = (await res.json()) as ApiError;
          if (j?.error) text += ` — ${j.error}`;
        } catch {}
        throw new Error(text);
      }
      const data = await res.json();
      const raw: any = data?.raw ?? null;

      if (raw) {
        setSettings({
          period_id: raw.period_id ?? periodId,
          avail_open_at: raw.avail_open_at ?? null,
          avail_deadline: raw.avail_deadline ?? null,
          weekly_reminder: coerceBool(raw.weekly_reminder, true),
          extra_reminder_hours: Array.isArray(raw.extra_reminder_hours) ? raw.extra_reminder_hours : [48, 24, 1],
          planning_generate_before_days: coerceNum(raw.planning_generate_before_days, 21),
          lock_assignments: coerceBool(raw.lock_assignments, false),
          slots_generate_before_days: raw.slots_generate_before_days ?? undefined,
          avail_deadline_before_days: raw.avail_deadline_before_days ?? undefined,
        });
      } else {
        // pas d'override : on garde period_id + defaults
        setSettings((s) => ({ ...s, period_id: periodId }));
      }
    } catch (e: any) {
      setMsg(`Erreur chargement : ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function saveSettings() {
    setSaving(true);
    setMsg('');
    try {
      const body: Settings = {
        ...settings,
        period_id: periodId || null,
      };
      const res = await withAuthFetch('/api/admin/automation-settings', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let text = `POST ${res.status}`;
        try {
          const j = (await res.json()) as ApiError;
          if (j?.error) text += ` — ${j.error}`;
        } catch {}
        throw new Error(text);
      }
      await res.json();
      setMsg('Réglages enregistrés ✅');
    } catch (e: any) {
      setMsg(`Erreur enregistrement : ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function testEmail(
    template: 'opening' | 'weekly' | 'deadline_48' | 'deadline_24' | 'deadline_1' | 'planning_ready'
  ) {
    setMsg('');
    try {
      const email = prompt('Adresse destinataire test ?');
      if (!email) return;
      const res = await withAuthFetch('/api/admin/email-test', {
        method: 'POST',
        body: JSON.stringify({ to: email, template, period_id: periodId || null }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
      setMsg('Email test envoyé ✅');
    } catch (e: any) {
      setMsg(`Erreur envoi test : ${e.message}`);
    }
  }

  const openAtValue = useMemo(() => toLocalInputValue(settings.avail_open_at), [settings.avail_open_at]);
  const deadlineValue = useMemo(() => toLocalInputValue(settings.avail_deadline), [settings.avail_deadline]);

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-semibold text-white">Paramètres & Rappels (emails)</h1>

      {/* Sélecteur de période : datalist pour éviter de taper l'UUID */}
      <div className="space-y-2">
        <label className="text-sm opacity-80">Période</label>
        <input
          list="period-list"
          value={periodId}
          onChange={(e) => setPeriodId(e.target.value)}
          placeholder="UUID de période (ou choisir dans la liste)"
          className="w-full rounded-md border px-3 py-2"
        />
        <datalist id="period-list">
          {periods.map((p) => (
            <option
              key={p.id}
              value={p.id}
              label={`${p.label} — ouvr. ${fmtShort(p.open_at)} · deadline ${fmtShort(p.close_at)}`}
            />
          ))}
        </datalist>
        <div className="flex gap-2">
          <button
            onClick={loadSettings}
            disabled={loading || !periodId}
            className="px-3 py-2 rounded-md bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {loading ? 'Chargement…' : 'Charger'}
          </button>
          {periodsLoading && <span className="text-xs text-zinc-400 self-center">Chargement des périodes…</span>}
        </div>
      </div>

      {/* Formulaire d’override pour la période sélectionnée */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm opacity-80">Ouverture des dispos (override)</label>
          <input
            type="datetime-local"
            value={openAtValue}
            onChange={(e) =>
              setSettings((s) => ({ ...s, avail_open_at: fromLocalInputValue(e.target.value) }))
            }
            className="w-full rounded-md border px-3 py-2"
          />
          <p className="text-xs text-zinc-400 mt-1">Laisse vide pour hériter de la période.</p>
        </div>

        <div>
          <label className="block text-sm opacity-80">Deadline des dispos (override)</label>
          <input
            type="datetime-local"
            value={deadlineValue}
            onChange={(e) =>
              setSettings((s) => ({ ...s, avail_deadline: fromLocalInputValue(e.target.value) }))
            }
            className="w-full rounded-md border px-3 py-2"
          />
          <p className="text-xs text-zinc-400 mt-1">Laisse vide pour hériter de la période.</p>
        </div>

        <div className="flex items-center gap-2">
          <input
            id="weekly"
            type="checkbox"
            checked={settings.weekly_reminder}
            onChange={(e) => setSettings((s) => ({ ...s, weekly_reminder: e.target.checked }))}
          />
          <label htmlFor="weekly" className="text-sm">Rappel hebdomadaire actif (override)</label>
        </div>

        <div>
          <label className="block text-sm opacity-80">Heures avant (rappels extra, ex: 48,24,1)</label>
          <input
            value={settings.extra_reminder_hours.join(',')}
            onChange={(e) => {
              const arr = e.target.value
                .split(',')
                .map((v) => Number(v.trim()))
                .filter((v) => Number.isFinite(v));
              setSettings((s) => ({ ...s, extra_reminder_hours: arr.length ? arr : [] }));
            }}
            className="w-full rounded-md border px-3 py-2"
          />
        </div>

        <div>
          <label className="block text-sm opacity-80">Jours avant génération planning</label>
          <input
            type="number"
            value={settings.planning_generate_before_days}
            onChange={(e) =>
              setSettings((s) => ({ ...s, planning_generate_before_days: Number(e.target.value || 0) }))
            }
            className="w-full rounded-md border px-3 py-2"
          />
        </div>

        <div className="flex items-center gap-2">
          <input
            id="lock"
            type="checkbox"
            checked={settings.lock_assignments}
            onChange={(e) => setSettings((s) => ({ ...s, lock_assignments: e.target.checked }))}
          />
          <label htmlFor="lock" className="text-sm">Verrouiller les assignations après génération</label>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <button
          onClick={saveSettings}
          disabled={saving || !periodId}
          className="px-4 py-2 rounded-md bg-green-600 text-white hover:bg-green-500 disabled:opacity-50"
        >
          {saving ? 'Enregistrement…' : 'Enregistrer'}
        </button>

        {/* Boutons de test e-mail avec IDs canoniques */}
        <button onClick={() => testEmail('opening')} className="px-3 py-2 rounded-md bg-zinc-800 text-white">Test “Ouverture”</button>
        <button onClick={() => testEmail('weekly')} className="px-3 py-2 rounded-md bg-zinc-800 text-white">Test “Hebdo”</button>
        <button onClick={() => testEmail('deadline_48')} className="px-3 py-2 rounded-md bg-zinc-800 text-white">Test “-48h”</button>
        <button onClick={() => testEmail('deadline_24')} className="px-3 py-2 rounded-md bg-zinc-800 text-white">Test “-24h”</button>
        <button onClick={() => testEmail('deadline_1')}  className="px-3 py-2 rounded-md bg-zinc-800 text-white">Test “-1h”</button>
        <button onClick={() => testEmail('planning_ready')} className="px-3 py-2 rounded-md bg-zinc-800 text-white">Test “Planning prêt”</button>
      </div>

      {!!msg && <p className="text-sm">{msg}</p>}

      {/* Tableau des périodes récentes (aperçu utile) */}
      <div className="rounded-xl border border-zinc-700 bg-zinc-800/60 p-4">
        <h2 className="text-lg font-semibold text-white mb-2">Périodes récentes</h2>
        {periods.length === 0 ? (
          <p className="text-sm text-zinc-400">Aucune période trouvée.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-zinc-400">
                  <th className="py-2 pr-4">Label</th>
                  <th className="py-2 pr-4">Ouverture</th>
                  <th className="py-2 pr-4">Deadline</th>
                  <th className="py-2 pr-4">Action</th>
                </tr>
              </thead>
              <tbody>
                {periods.map((p) => (
                  <tr key={p.id} className="border-t border-zinc-700">
                    <td className="py-2 pr-4 text-zinc-200">{p.label}</td>
                    <td className="py-2 pr-4">{fmt(p.open_at)}</td>
                    <td className="py-2 pr-4">{fmt(p.close_at)}</td>
                    <td className="py-2 pr-4">
                      <button
                        onClick={() => setPeriodId(p.id)}
                        className="px-2 py-1 rounded-md bg-zinc-700 hover:bg-zinc-600 text-white"
                      >
                        Sélectionner
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Helpers ----
function toLocalInputValue(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}
function fromLocalInputValue(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}
function coerceBool(v: any, d: boolean) {
  return typeof v === 'boolean' ? v : d;
}
function coerceNum(v: any, d: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function fmt(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
}
function fmtShort(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
