'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';

type Period = { id: string; label: string };

type Settings = {
  period_id: string;
  slots_generate_before_days: number;
  avail_open_at: string | null;       // ISO string or null
  avail_deadline: string | null;      // ISO string or null
  weekly_reminder: boolean;
  extra_reminder_hours: number[];     // ex: [48,24,1]
  planning_generate_before_days: number;
  lock_assignments: boolean;
};

function isoToLocalInput(v: string | null): string {
  if (!v) return '';
  const d = new Date(v);
  // yyyy-MM-ddTHH:mm
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const HH = pad(d.getHours());
  const MM = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${HH}:${MM}`;
}

function localInputToISO(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return d.toISOString();
}

export default function AutomationAdminPage() {
  const [periods, setPeriods] = useState<Period[]>([]);
  const [periodId, setPeriodId] = useState<string>('');
  const [settings, setSettings] = useState<Settings | null>(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Charger la liste des périodes
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
      const def = list[0]?.id ?? '';
      setPeriodId(def);
      setLoading(false);
    })();
  }, []);

  // Charger les settings de la période via l'API /api/admin/automation-settings
  useEffect(() => {
    (async () => {
      if (!periodId) { setSettings(null); return; }
      setMsg(null);
      setLoading(true);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;

        const res = await fetch(`/api/admin/automation-settings?period_id=${encodeURIComponent(periodId)}`, {
          headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error ?? 'Erreur chargement settings');

        // normaliser extra_reminder_hours si absent
        if (!Array.isArray(json.extra_reminder_hours)) {
          json.extra_reminder_hours = [48, 24, 1];
        }

        setSettings(json as Settings);
      } catch (e: any) {
        setMsg(`Erreur chargement: ${e.message}`);
        setSettings(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [periodId]);

  const extraHoursText = useMemo(() => {
    if (!settings) return '';
    return (settings.extra_reminder_hours ?? []).join(',');
  }, [settings]);

  const onSave = async () => {
    if (!settings) return;
    setSaving(true);
    setMsg(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      const res = await fetch('/api/admin/automation-settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(settings),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? 'Erreur sauvegarde');
      setSettings(json as Settings);
      setMsg('✅ Paramètres enregistrés');
    } catch (e: any) {
      setMsg(`❌ Sauvegarde: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl p-4 space-y-6">
      <h1 className="text-2xl font-bold text-white">Automatisation</h1>

      {/* Sélecteur de période */}
      <div className="flex items-center gap-3">
        <label className="text-sm text-zinc-300">Période</label>
        <select
          className="border border-zinc-700 rounded bg-zinc-900 text-zinc-100 px-2 py-1"
          value={periodId}
          onChange={(e) => setPeriodId(e.target.value)}
        >
          <option value="">— choisir —</option>
          {periods.map(p => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </div>

      {msg && (
        <div className={`p-3 rounded-lg border ${msg.startsWith('❌') ? 'border-red-800 bg-red-950 text-red-200' : 'border-zinc-700 bg-zinc-800 text-zinc-100'}`}>
          {msg}
        </div>
      )}

      {loading && <div className="text-zinc-400">Chargement…</div>}

      {!!settings && !loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Carte 1 */}
          <div className="rounded-xl border border-zinc-700 bg-zinc-900/60 p-4 space-y-3">
            <h2 className="text-lg font-semibold text-white">Création & Disponibilités</h2>

            <label className="block text-sm text-zinc-300">
              Jours avant le trimestre pour générer les slots
              <input
                type="number"
                className="mt-1 w-full border border-zinc-700 rounded bg-zinc-900 text-zinc-100 px-2 py-1"
                value={settings.slots_generate_before_days}
                onChange={(e) =>
                  setSettings(s => s ? { ...s, slots_generate_before_days: Number(e.target.value) || 0 } : s)
                }
              />
            </label>

            <label className="block text-sm text-zinc-300">
              Ouverture des dispos (date/heure)
              <input
                type="datetime-local"
                className="mt-1 w-full border border-zinc-700 rounded bg-zinc-900 text-zinc-100 px-2 py-1"
                value={isoToLocalInput(settings.avail_open_at)}
                onChange={(e) =>
                  setSettings(s => s ? { ...s, avail_open_at: localInputToISO(e.target.value) } : s)
                }
              />
            </label>

            <label className="block text-sm text-zinc-300">
              Deadline des dispos (date/heure)
              <input
                type="datetime-local"
                className="mt-1 w-full border border-zinc-700 rounded bg-zinc-900 text-zinc-100 px-2 py-1"
                value={isoToLocalInput(settings.avail_deadline)}
                onChange={(e) =>
                  setSettings(s => s ? { ...s, avail_deadline: localInputToISO(e.target.value) } : s)
                }
              />
            </label>

            <label className="inline-flex items-center gap-2 text-sm text-zinc-300">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={settings.weekly_reminder}
                onChange={(e) => setSettings(s => s ? { ...s, weekly_reminder: e.target.checked } : s)}
              />
              Rappel hebdo tant que non validé
            </label>

            <label className="block text-sm text-zinc-300">
              Rappels supplémentaires (heures, ex: 48,24,1)
              <input
                type="text"
                className="mt-1 w-full border border-zinc-700 rounded bg-zinc-900 text-zinc-100 px-2 py-1"
                value={extraHoursText}
                onChange={(e) => {
                  const parts = e.target.value.split(',').map(s => Number(s.trim())).filter(Number.isFinite);
                  setSettings(s => s ? { ...s, extra_reminder_hours: parts } : s);
                }}
              />
            </label>
          </div>

          {/* Carte 2 */}
          <div className="rounded-xl border border-zinc-700 bg-zinc-900/60 p-4 space-y-3">
            <h2 className="text-lg font-semibold text-white">Génération du planning</h2>

            <label className="block text-sm text-zinc-300">
              Jours avant début du trimestre pour générer le planning
              <input
                type="number"
                className="mt-1 w-full border border-zinc-700 rounded bg-zinc-900 text-zinc-100 px-2 py-1"
                value={settings.planning_generate_before_days}
                onChange={(e) =>
                  setSettings(s => s ? { ...s, planning_generate_before_days: Number(e.target.value) || 0 } : s)
                }
              />
            </label>

            <label className="inline-flex items-center gap-2 text-sm text-zinc-300">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={settings.lock_assignments}
                onChange={(e) => setSettings(s => s ? { ...s, lock_assignments: e.target.checked } : s)}
              />
              Verrouiller les assignations après validation
            </label>

            <div className="pt-2">
              <button
                onClick={onSave}
                disabled={saving}
                className="rounded-lg bg-blue-600 text-white px-4 py-2 disabled:opacity-50"
              >
                {saving ? 'Sauvegarde…' : 'Enregistrer'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
