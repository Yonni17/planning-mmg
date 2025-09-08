'use client'; // <= DOIT être la 1ère ligne

// Ces deux lignes peuvent rester après 'use client' si tu veux forcer du dynamique
export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

// ---- Supabase client (client-side, anon key) ----
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

  // TOUT passe par l’API admin avec un Bearer token
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
    setLoading(true);
    setMsg('');
    try {
      const url = `/api/admin/automation-settings${periodId ? `?period_id=${encodeURIComponent(periodId)}` : ''}`;
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
      // Le handler GET renvoie { scope, period_id, effective, raw, global }
      const raw: Settings | null = data?.raw ?? null;
      if (raw) {
        setSettings({
          period_id: raw.period_id ?? (periodId || null),
          avail_open_at: raw.avail_open_at ?? null,
          avail_deadline: raw.avail_deadline ?? null,
          weekly_reminder: coerceBool(raw.weekly_reminder, true),
          extra_reminder_hours: Array.isArray(raw.extra_reminder_hours) ? raw.extra_reminder_hours : [],
          planning_generate_before_days: coerceNum(raw.planning_generate_before_days, 21),
          lock_assignments: coerceBool(raw.lock_assignments, false),
          slots_generate_before_days: raw.slots_generate_before_days ?? undefined,
          avail_deadline_before_days: raw.avail_deadline_before_days ?? undefined,
        });
      } else {
        // Pas d’override → on repart des valeurs globales/effective montrées en read-only
        setSettings((s) => ({
          ...s,
          period_id: periodId || null,
        }));
      }
      setMsg('');
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
      const saved = await res.json();
      // On reflète la sauvegarde côté UI
      setMsg('Réglages enregistrés ✅');
      // Optionnel: recharger pour voir l’“effective”
      // await loadSettings();
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

  useEffect(() => {
    loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId]);

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Automation & Rappels (emails)</h1>

      <div className="space-y-2">
        <label className="text-sm opacity-80">Période (UUID, vide = réglages globaux)</label>
        <input
          value={periodId}
          onChange={(e) => setPeriodId(e.target.value)}
          placeholder="UUID de période (optionnel)"
          className="w-full rounded-md border px-3 py-2"
        />
        <div className="flex gap-2">
          <button
            onClick={loadSettings}
            disabled={loading}
            className="px-3 py-2 rounded-md bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {loading ? 'Chargement…' : 'Recharger'}
          </button>
          <button
            onClick={() => setPeriodId('')}
            className="px-3 py-2 rounded-md bg-zinc-200 hover:bg-zinc-300"
          >
            Basculer sur global
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm opacity-80">Ouverture des dispos</label>
          <input
            type="datetime-local"
            value={openAtValue}
            onChange={(e) =>
              setSettings((s) => ({ ...s, avail_open_at: fromLocalInputValue(e.target.value) }))
            }
            className="w-full rounded-md border px-3 py-2"
          />
        </div>

        <div>
          <label className="block text-sm opacity-80">Deadline des dispos</label>
          <input
            type="datetime-local"
            value={deadlineValue}
            onChange={(e) =>
              setSettings((s) => ({ ...s, avail_deadline: fromLocalInputValue(e.target.value) }))
            }
            className="w-full rounded-md border px-3 py-2"
          />
        </div>

        <div className="flex items-center gap-2">
          <input
            id="weekly"
            type="checkbox"
            checked={settings.weekly_reminder}
            onChange={(e) => setSettings((s) => ({ ...s, weekly_reminder: e.target.checked }))}
          />
          <label htmlFor="weekly" className="text-sm">Rappel hebdomadaire actif</label>
        </div>

        <div>
          <label className="block text-sm opacity-80">Heures avant (rappels extra)</label>
          <input
            value={settings.extra_reminder_hours.join(',')}
            onChange={(e) => {
              const arr = e.target.value
                .split(',')
                .map((v) => Number(v.trim()))
                .filter((v) => Number.isFinite(v));
              setSettings((s) => ({ ...s, extra_reminder_hours: arr }));
            }}
            placeholder="ex: 48,24,1"
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
          disabled={saving}
          className="px-4 py-2 rounded-md bg-green-600 text-white hover:bg-green-500 disabled:opacity-50"
        >
          {saving ? 'Enregistrement…' : 'Enregistrer'}
        </button>

        <button onClick={() => testEmail('opening')} className="px-3 py-2 rounded-md bg-zinc-800 text-white">Test “Ouverture”</button>
        <button onClick={() => testEmail('weekly')} className="px-3 py-2 rounded-md bg-zinc-800 text-white">Test “Hebdo”</button>
        <button onClick={() => testEmail('deadline_48')} className="px-3 py-2 rounded-md bg-zinc-800 text-white">Test “-48h”</button>
        <button onClick={() => testEmail('deadline_24')} className="px-3 py-2 rounded-md bg-zinc-800 text-white">Test “-24h”</button>
        <button onClick={() => testEmail('deadline_1')} className="px-3 py-2 rounded-md bg-zinc-800 text-white">Test “-1h”</button>
        <button onClick={() => testEmail('planning_ready')} className="px-3 py-2 rounded-md bg-zinc-800 text-white">Test “Planning prêt”</button>
      </div>

      {!!msg && <p className="text-sm">{msg}</p>}
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
