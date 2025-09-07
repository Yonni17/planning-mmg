'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type Period = {
  id: string;
  label: string;
  open_at: string;     // timestamptz
  close_at: string;    // timestamptz
  generate_at: string; // timestamptz (compte à rebours côté app)
  timezone: string | null;
};

type AutoRow = {
  period_id: string;

  // J - x
  slots_generate_before_days: number;     // ouverture des dispos + génération des slots
  avail_deadline_before_days: number;     // clôture des dispos
  planning_generate_before_days: number;  // génération auto du planning (en brouillon)

  // rappels
  weekly_reminder: boolean;
  extra_reminder_hours: number[];

  // publication
  lock_assignments: boolean;

  // dérivés (info)
  avail_open_at?: string | null;
  avail_deadline?: string | null;
  updated_at?: string | null;
};

function parseCsvInts(s: string): number[] {
  return s
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => Number.parseInt(x, 10))
    .filter((n) => Number.isFinite(n));
}

function fmtDateFR(iso?: string | null) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('fr-FR', {
      dateStyle: 'full',
      timeStyle: 'short',
    });
  } catch {
    return iso || '—';
  }
}

async function parseJsonSafe(res: Response) {
  const txt = await res.text();
  try {
    return txt ? JSON.parse(txt) : {};
  } catch {
    return { __raw: txt };
  }
}

export default function AutomationAdminPage() {
  const [periods, setPeriods] = useState<Period[]>([]);
  const [periodId, setPeriodId] = useState<string>('');

  const [row, setRow] = useState<AutoRow | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // états du formulaire
  const [leadSlots, setLeadSlots] = useState<number>(45);
  const [leadDeadline, setLeadDeadline] = useState<number>(15);
  const [leadGenerate, setLeadGenerate] = useState<number>(21);
  const [weekly, setWeekly] = useState<boolean>(true);
  const [extraHoursCsv, setExtraHoursCsv] = useState<string>('48,24,1');
  const [lockAssign, setLockAssign] = useState<boolean>(false);

  // ------------------ Init
  useEffect(() => {
    (async () => {
      setLoading(true);
      setMsg(null);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;

        const res = await fetch('/api/admin/automation-settings', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        const json = await parseJsonSafe(res);
        if (!res.ok) throw new Error((json as any)?.error || `HTTP ${res.status}`);

        const list = (json as any)?.periods as Period[] || [];
        setPeriods(list);

        const def = list[0]?.id || '';
        setPeriodId(def);
        if (def) await load(def);
      } catch (e: any) {
        setMsg(`❌ ${e?.message || 'Erreur chargement'}`);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function load(pid: string) {
    setMsg(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      const res = await fetch(`/api/admin/automation-settings?period_id=${encodeURIComponent(pid)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const json = await parseJsonSafe(res);
      if (!res.ok) throw new Error((json as any)?.error || `HTTP ${res.status}`);

      const r = (json as any)?.row as AutoRow;
      setRow(r);

      setLeadSlots(r?.slots_generate_before_days ?? 45);
      setLeadDeadline(r?.avail_deadline_before_days ?? 15);
      setLeadGenerate(r?.planning_generate_before_days ?? 21);
      setWeekly(!!r?.weekly_reminder);
      setExtraHoursCsv((r?.extra_reminder_hours ?? [48, 24, 1]).join(','));
      setLockAssign(!!r?.lock_assignments);
    } catch (e: any) {
      setMsg(`❌ ${e?.message || 'Erreur chargement période'}`);
    }
  }

  // aperçu des dates calculées
  const preview = useMemo(() => {
    if (!row) return null;
    const p = periods.find(pp => pp.id === row.period_id);
    if (!p) return null;

    const start = new Date(p.open_at);
    const mk = (days: number) => {
      const d = new Date(start.getTime() - days * 24 * 3600 * 1000);
      return d.toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' });
    };

    return {
      open: mk(leadSlots),
      deadline: mk(leadDeadline),
      generate: mk(leadGenerate),
    };
  }, [row, periods, leadSlots, leadDeadline, leadGenerate]);

  const onSave = async () => {
    if (!periodId) return;
    setMsg(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      const body = {
        period_id: periodId,
        slots_generate_before_days: Number.isFinite(leadSlots) ? leadSlots : 45,
        avail_deadline_before_days: Number.isFinite(leadDeadline) ? leadDeadline : 15,
        planning_generate_before_days: Number.isFinite(leadGenerate) ? leadGenerate : 21,
        weekly_reminder: weekly,
        extra_reminder_hours: parseCsvInts(extraHoursCsv),
        lock_assignments: lockAssign,
      };

      const res = await fetch('/api/admin/automation-settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      const json = await parseJsonSafe(res);
      if (!res.ok) throw new Error((json as any)?.error || `HTTP ${res.status}`);

      await load(periodId);
      setMsg('✅ Paramètres enregistrés. Les dates calculées ont été mises à jour.');
    } catch (e: any) {
      setMsg(`❌ ${e?.message || 'Erreur sauvegarde'}`);
    }
  };

  return (
    <div className="mx-auto max-w-5xl p-6 space-y-6">
      <h1 className="text-2xl font-semibold text-white">Automatisation</h1>

      <div className="flex items-center gap-3">
        <span className="text-sm text-zinc-300">Période</span>
        <select
          className="border rounded px-2 py-1 bg-zinc-900 text-zinc-100 border-zinc-700"
          value={periodId}
          onChange={async (e) => {
            const v = e.target.value;
            setPeriodId(v);
            if (v) await load(v);
          }}
        >
          {periods.map(p => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </div>

      {msg && (
        <div className={`p-3 rounded border ${msg.startsWith('❌') ? 'border-red-700 bg-red-900/30 text-red-200' : 'border-emerald-700 bg-emerald-900/30 text-emerald-200'}`}>
          {msg}
        </div>
      )}

      {loading || !row ? (
        <div className="text-zinc-400">Chargement…</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Création & Dispos */}
          <div className="rounded-xl border border-zinc-700 bg-zinc-800/60 p-4 space-y-4">
            <h2 className="text-lg font-medium text-white">Création & disponibilités</h2>

            <label className="block text-sm text-zinc-300">
              Jours avant <i>le début du trimestre</i> pour <b>générer les créneaux</b> et <b>ouvrir la saisie des disponibilités</b>
              <input
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-100 px-3 py-2"
                value={leadSlots}
                onChange={(e) => setLeadSlots(parseInt(e.target.value || '0', 10))}
                type="number"
                min={0}
              />
              <div className="text-xs text-zinc-400 mt-1">Ouvre le {preview?.open ?? '—'}</div>
            </label>

            <label className="block text-sm text-zinc-300">
              Jours avant <i>le début du trimestre</i> pour <b>clôturer la saisie des disponibilités</b>
              <input
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-100 px-3 py-2"
                value={leadDeadline}
                onChange={(e) => setLeadDeadline(parseInt(e.target.value || '0', 10))}
                type="number"
                min={0}
              />
              <div className="text-xs text-zinc-400 mt-1">Clôture le {preview?.deadline ?? '—'}</div>
            </label>

            <div className="pt-2 border-t border-zinc-700/60">
              <label className="inline-flex items-center gap-2 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  className="accent-blue-500"
                  checked={weekly}
                  onChange={(e) => setWeekly(e.target.checked)}
                />
                Rappel hebdo tant que l’utilisateur n’a pas validé ses dispos
              </label>

              <label className="block mt-2 text-sm text-zinc-300">
                Rappels supplémentaires avant la clôture (heures, ex: <code>48,24,1</code>)
                <input
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-100 px-3 py-2"
                  value={extraHoursCsv}
                  onChange={(e) => setExtraHoursCsv(e.target.value)}
                  placeholder="48,24,1"
                />
              </label>
            </div>
          </div>

          {/* Planning */}
          <div className="rounded-xl border border-zinc-700 bg-zinc-800/60 p-4 space-y-4">
            <h2 className="text-lg font-medium text-white">Génération du planning</h2>

            <label className="block text-sm text-zinc-300">
              Jours avant <i>le début du trimestre</i> pour <b>générer automatiquement</b> le planning
              <input
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-100 px-3 py-2"
                value={leadGenerate}
                onChange={(e) => setLeadGenerate(parseInt(e.target.value || '0', 10))}
                type="number"
                min={0}
              />
              <div className="text-xs text-zinc-400 mt-1">Génération prévue le {preview?.generate ?? '—'}</div>
            </label>

            <label className="inline-flex items-center gap-2 text-sm text-zinc-300">
              <input
                type="checkbox"
                className="accent-blue-500"
                checked={lockAssign}
                onChange={(e) => setLockAssign(e.target.checked)}
              />
              Verrouiller les assignations après publication
            </label>

            <div className="pt-2">
              <button
                onClick={onSave}
                className="px-4 py-2 rounded-lg border border-blue-500 text-white bg-blue-600 hover:bg-blue-500"
              >
                Enregistrer
              </button>
              {row.updated_at && (
                <div className="mt-2 text-xs text-zinc-400">
                  Dernière mise à jour : {fmtDateFR(row.updated_at)}
                </div>
              )}
              <div className="mt-2 text-xs text-zinc-400">
                Note : la date calculée est recopiée dans <code>periods.generate_at</code> pour le compte à rebours côté utilisateurs.
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
