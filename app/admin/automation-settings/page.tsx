'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type Settings = {
  period_id: string | null;
  avail_open_at: string | null;
  avail_deadline: string | null;
  weekly_reminder: boolean;
  extra_reminder_hours: number[];   // ex: [48,24,1]
  planning_generate_before_days: number; // ex: 21
  lock_assignments: boolean;
};

export default function AutomationSettingsPage() {
  const [periodId, setPeriodId] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<Settings>({
    period_id: null,
    avail_open_at: null,
    avail_deadline: null,
    weekly_reminder: true,
    extra_reminder_hours: [48, 24, 1],
    planning_generate_before_days: 21,
    lock_assignments: false,
  });
  const [message, setMessage] = useState<string>('');

  async function withAuthFetch(input: RequestInfo, init: RequestInit = {}) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return fetch(input, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      credentials: 'include',
    });
  }

  async function loadSettings() {
    setLoading(true);
    setMessage('');
    try {
      const url = `/api/admin/automation-settings${periodId ? `?period_id=${encodeURIComponent(periodId)}` : ''}`;
      const res = await withAuthFetch(url);
      if (!res.ok) throw new Error(`GET ${res.status}`);
      const data = await res.json();
      setSettings(data);
    } catch (e: any) {
      setMessage(`Erreur chargement : ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function saveSettings() {
    setSaving(true);
    setMessage('');
    try {
      const res = await withAuthFetch('/api/admin/automation-settings', {
        method: 'POST',
        body: JSON.stringify({ ...settings, period_id: periodId || null }),
      });
      if (!res.ok) throw new Error(`POST ${res.status}`);
      const data = await res.json();
      setSettings(data);
      setMessage('Réglages enregistrés ✅');
    } catch (e: any) {
      setMessage(`Erreur enregistrement : ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function testEmail(template: 'opening' | 'weekly' | 'deadline_48' | 'deadline_24' | 'deadline_1' | 'planning_ready') {
    setMessage('');
    try {
      const email = prompt('Adresse destinataire test ?');
      if (!email) return;
      const res = await withAuthFetch('/api/admin/email-test', {
        method: 'POST',
        body: JSON.stringify({ to: email, template, period_id: periodId || null }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
      setMessage('Email test envoyé ✅');
    } catch (e: any) {
      setMessage(`Erreur envoi test : ${e.message}`);
    }
  }

  useEffect(() => {
    loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId]);

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-semibold text-white">Automation & Rappels (emails)</h1>

      <div className="space-y-2">
        <label className="text-sm text-zinc-300">Période (UUID, vide = global)</label>
        <input
          value={periodId}
          onChange={(e) => setPeriodId(e.target.value)}
          placeholder="UUID de période (optionnel)"
          className="w-full rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2 text-white"
        />
        <button
          onClick={loadSettings}
          disabled={loading}
          className="px-3 py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-white"
        >
          {loading ? 'Chargement…' : 'Recharger'}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm text-zinc-300">Ouverture des dispos (ISO)</label>
          <input
            type="datetime-local"
            value={settings.avail_open_at ?? ''}
            onChange={(e) => setSettings(s => ({ ...s, avail_open_at: e.target.value || null }))}
            className="w-full rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2 text-white"
          />
        </div>
        <div>
          <label className="block text-sm text-zinc-300">Deadline des dispos (ISO)</label>
          <input
            type="datetime-local"
            value={settings.avail_deadline ?? ''}
            onChange={(e) => setSettings(s => ({ ...s, avail_deadline: e.target.value || null }))}
            className="w-full rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2 text-white"
          />
        </div>
        <div className="flex items-center gap-2">
          <input
            id="weekly"
            type="checkbox"
            checked={settings.weekly_reminder}
            onChange={(e) => setSettings(s => ({ ...s, weekly_reminder: e.target.checked }))}
          />
          <label htmlFor="weekly" className="text-sm text-zinc-300">Rappel hebdo actif</label>
        </div>
        <div>
          <label className="block text-sm text-zinc-300">Heures avant (rappels extra)</label>
          <input
            value={settings.extra_reminder_hours.join(',')}
            onChange={(e) => {
              const arr = e.target.value.split(',').map(v => Number(v.trim())).filter(v => Number.isFinite(v));
              setSettings(s => ({ ...s, extra_reminder_hours: arr }));
            }}
            placeholder="ex: 48,24,1"
            className="w-full rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2 text-white"
          />
        </div>
        <div>
          <label className="block text-sm text-zinc-300">Jours avant génération planning</label>
          <input
            type="number"
            value={settings.planning_generate_before_days}
            onChange={(e) => setSettings(s => ({ ...s, planning_generate_before_days: Number(e.target.value || 0) }))}
            className="w-full rounded-md bg-zinc-900 border border-zinc-700 px-3 py-2 text-white"
          />
        </div>
        <div className="flex items-center gap-2">
          <input
            id="lock"
            type="checkbox"
            checked={settings.lock_assignments}
            onChange={(e) => setSettings(s => ({ ...s, lock_assignments: e.target.checked }))}
          />
          <label htmlFor="lock" className="text-sm text-zinc-300">Verrouiller assignations (post-génération)</label>
        </div>
      </div>

      <div className="flex gap-3">
        <button
          onClick={saveSettings}
          disabled={saving}
          className="px-4 py-2 rounded-md bg-green-600 hover:bg-green-500 text-white"
        >
          {saving ? 'Enregistrement…' : 'Enregistrer'}
        </button>

        <button
          onClick={() => testEmail('opening')}
          className="px-3 py-2 rounded-md bg-zinc-800 hover:bg-zinc-700 text-white"
        >
          Test “Ouverture”
        </button>
        <button onClick={() => testEmail('weekly')} className="px-3 py-2 rounded-md bg-zinc-800 hover:bg-zinc-700 text-white">Test “Hebdo”</button>
        <button onClick={() => testEmail('deadline_48')} className="px-3 py-2 rounded-md bg-zinc-800 hover:bg-zinc-700 text-white">Test “-48h”</button>
        <button onClick={() => testEmail('deadline_24')} className="px-3 py-2 rounded-md bg-zinc-800 hover:bg-zinc-700 text-white">Test “-24h”</button>
        <button onClick={() => testEmail('deadline_1')} className="px-3 py-2 rounded-md bg-zinc-800 hover:bg-zinc-700 text-white">Test “-1h”</button>
        <button onClick={() => testEmail('planning_ready')} className="px-3 py-2 rounded-md bg-zinc-800 hover:bg-zinc-700 text-white">Test “Planning prêt”</button>
      </div>

      {!!message && <p className="text-sm text-amber-300">{message}</p>}
    </div>
  );
}
