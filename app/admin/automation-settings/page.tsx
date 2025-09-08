'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

// ---- Supabase client (client-side, anon key) ----
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// ---- Types ----
type Settings = {
  period_id: string | null;
  avail_open_at: string | null;           // ISO string (YYYY-MM-DDTHH:mm)
  avail_deadline: string | null;          // ISO string
  weekly_reminder: boolean;               // send weekly nudges
  extra_reminder_hours: number[];         // e.g. [48,24,1]
  planning_generate_before_days: number;  // e.g. 21
  lock_assignments: boolean;              // lock after generation
};

type ApiError = { error?: string };

// ---- Page ----
export default function AutomationSettingsPage() {
  const [periodId, setPeriodId] = useState<string>(''); // empty = global
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

  // Util to always send Bearer token to admin API routes
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

  // Load settings (global or per-period)
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
      const data = (await res.json()) as Settings;
      // Normalize arrays (in case API returns null)
      setSettings({
        ...data,
        extra_reminder_hours: Array.isArray(data.extra_reminder_hours)
          ? data.extra_reminder_hours
          : [],
      });
    } catch (e: any) {
      setMsg(`Erreur chargement : ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  // Save settings
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
      const saved = (await res.json()) as Settings;
      setSettings({
        ...saved,
        extra_reminder_hours: Array.isArray(saved.extra_reminder_hours)
          ? saved.extra_reminder_hours
          : [],
      });
      setMsg('Réglages enregistrés ✅');
    } catch (e: any) {
      setMsg(`Erreur enregistrement : ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  // Trigger a test email for a given template
  async function testEmail(
    template:
      | 'opening'
      | 'weekly'
      | 'deadline_48'
      | 'deadline_24'
      | 'deadline_1'
      | 'planning_ready'
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
      if (!res.ok) {
        const err = j?.error ? `HTTP ${res.status} — ${j.error}` : `HTTP ${res.status}`;
        throw new Error(err);
      }
      setMsg('Email test envoyé ✅');
    } catch (e: any) {
      setMsg(`Erreur envoi test : ${e.message}`);
    }
  }

  // Helpers for datetime-local inputs (they expect "YYYY-MM-DDTHH:mm")
  const openAtValue = useMemo(() => toLocalInputValue(settings.avail_open_at), [settings.avail_open_at]);
  const deadlineValue = useMemo(() => toLocalInputValue(settings.avail_deadline), [settings.avail_deadline]);

  useEffect(() => {
    loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId]);

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Automation & Rappels (emails)</h1>

      {/* Scope selector */}
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

      {/* Settings form */}
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
          <p className="text-xs opacity-60 mt-1">
            Quand les médecins peuvent commencer à remplir leurs disponibilités.
          </p>
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
          <p className="text-xs opacity-60 mt-1">
            Date/heure limite pour compléter ses disponibilités.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <input
            id="weekly"
            type="checkbox"
            checked={settings.weekly_reminder}
            onChange={(e) => setSettings((s) => ({ ...s, weekly_reminder: e.target.checked }))}
          />
          <label htmlFor="weekly" className="text-sm">
            Rappel hebdomadaire actif
          </label>
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
          <p className="text-xs opacity-60 mt-1">
            Enverra des rappels à J-2, J-1, H-1 avant la&nbsp;deadline.
          </p>
        </div>

        <div>
          <label className="block text-sm opacity-80">Jours avant génération planning</label>
          <input
            type="number"
            value={settings.planning_generate_before_days}
            onChange={(e) =>
              setSettings((s) => ({
                ...s,
                planning_generate_before_days: Number(e.target.value || 0),
              }))
            }
            className="w-full rounded-md border px-3 py-2"
          />
          <p className="text-xs opacity-60 mt-1">
            Le moteur peut générer le planning X jours avant le début de la période.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <input
            id="lock"
            type="checkbox"
            checked={settings.lock_assignments}
            onChange={(e) => setSettings((s) => ({ ...s, lock_assignments: e.target.checked }))}
          />
          <label htmlFor="lock" className="text-sm">
            Verrouiller les assignations après génération
          </label>
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-3">
        <button
          onClick={saveSettings}
          disabled={saving}
          className="px-4 py-2 rounded-md bg-green-600 text-white hover:bg-green-500 disabled:opacity-50"
        >
          {saving ? 'Enregistrement…' : 'Enregistrer'}
        </button>

        {/* Test buttons */}
        <button onClick={() => testEmail('opening')} className="px-3 py-2 rounded-md bg-zinc-800 text-white">
          Test “Ouverture”
        </button>
        <button onClick={() => testEmail('weekly')} className="px-3 py-2 rounded-md bg-zinc-800 text-white">
          Test “Hebdo”
        </button>
        <button onClick={() => testEmail('deadline_48')} className="px-3 py-2 rounded-md bg-zinc-800 text-white">
          Test “-48h”
        </button>
        <button onClick={() => testEmail('deadline_24')} className="px-3 py-2 rounded-md bg-zinc-800 text-white">
          Test “-24h”
        </button>
        <button onClick={() => testEmail('deadline_1')} className="px-3 py-2 rounded-md bg-zinc-800 text-white">
          Test “-1h”
        </button>
        <button onClick={() => testEmail('planning_ready')} className="px-3 py-2 rounded-md bg-zinc-800 text-white">
          Test “Planning prêt”
        </button>
      </div>

      {!!msg && <p className="text-sm">{msg}</p>}
    </div>
  );
}

// ---- Helpers for <input type="datetime-local"> ----
// Store ISO in DB (UTC or TZ'd), but show "YYYY-MM-DDTHH:mm" to the user.

function toLocalInputValue(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  // Convert to local "YYYY-MM-DDTHH:mm"
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function fromLocalInputValue(local: string): string | null {
  if (!local) return null;
  // Assume local string -> ISO (keep local time; backend may treat as local TZ or convert to UTC)
  const d = new Date(local);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}