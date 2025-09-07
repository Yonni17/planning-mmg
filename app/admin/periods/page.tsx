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
  open_at: string | null;      // ISO
  close_at: string | null;     // ISO
  generate_at: string | null;  // ISO
  timezone: string | null;
  created_at?: string | null;
};

type FormRow = {
  id?: string;
  label: string;
  open_at: string;     // datetime-local value
  close_at: string;    // datetime-local value
  generate_at: string; // datetime-local value
  timezone: string;
  isNew?: boolean;
  dirty?: boolean;
};

function toLocalInputValue(iso?: string | null) {
  if (!iso) return '';
  // convert ISO (UTC) to local 'YYYY-MM-DDTHH:mm'
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function toISOStringFromLocalInput(value: string) {
  // value is 'YYYY-MM-DDTHH:mm' in local tz -> to UTC ISO
  if (!value) return null;
  const d = new Date(value);
  return d.toISOString();
}

async function parseJsonSafe(res: Response) {
  const txt = await res.text();
  try { return txt ? JSON.parse(txt) : {}; } catch { return { __raw: txt }; }
}

export default function AdminPeriodsPage() {
  const [rows, setRows] = useState<FormRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setMsg(null);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        const res = await fetch('/api/admin/periods', {
          headers: token ? { Authorization: `Bearer ${token}` } : {}
        });
        const json = await parseJsonSafe(res);
        if (!res.ok) throw new Error((json as any)?.error || `HTTP ${res.status}`);

        const list = (json as any)?.periods as Period[] || [];
        const mapped: FormRow[] = list.map(p => ({
          id: p.id,
          label: p.label,
          open_at: toLocalInputValue(p.open_at),
          close_at: toLocalInputValue(p.close_at),
          generate_at: toLocalInputValue(p.generate_at),
          timezone: p.timezone || 'Europe/Paris',
          isNew: false,
          dirty: false,
        }));
        setRows(mapped);
      } catch (e: any) {
        setMsg(`❌ ${e?.message || 'Erreur de chargement'}`);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const addRow = () => {
    setRows(prev => ([
      ...prev,
      {
        isNew: true,
        dirty: true,
        label: '',
        open_at: '',
        close_at: '',
        generate_at: '',
        timezone: 'Europe/Paris',
      }
    ]));
  };

  const removeRowLocal = (idx: number) => {
    setRows(prev => prev.filter((_, i) => i !== idx));
  };

  const onChangeField = (idx: number, key: keyof FormRow, val: string) => {
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, [key]: val, dirty: true } : r));
  };

  const setGenerateMinus15Days = (idx: number) => {
    const row = rows[idx];
    if (!row.open_at) return;
    const d = new Date(row.open_at);
    d.setDate(d.getDate() - 15);
    const pad = (n: number) => String(n).padStart(2, '0');
    const local = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    onChangeField(idx, 'generate_at', local);
  };

  const saveRow = async (idx: number) => {
    setMsg(null);
    const r = rows[idx];
    if (!r.label) { setMsg('❌ Label requis'); return; }
    if (!r.open_at || !r.close_at) { setMsg('❌ Ouverture et fermeture sont requises'); return; }

    const payload = {
      id: r.id,
      label: r.label,
      open_at: toISOStringFromLocalInput(r.open_at),
      close_at: toISOStringFromLocalInput(r.close_at),
      generate_at: toISOStringFromLocalInput(r.generate_at),
      timezone: r.timezone || 'Europe/Paris',
    };

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      const res = await fetch('/api/admin/periods', {
        method: r.isNew ? 'POST' : 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify(payload),
      });
      const json = await parseJsonSafe(res);
      if (!res.ok) throw new Error((json as any)?.error || `HTTP ${res.status}`);

      // replace row with server echo
      const saved = (json as any)?.period as Period;
      const updated: FormRow = {
        id: saved.id,
        label: saved.label,
        open_at: toLocalInputValue(saved.open_at),
        close_at: toLocalInputValue(saved.close_at),
        generate_at: toLocalInputValue(saved.generate_at),
        timezone: saved.timezone || 'Europe/Paris',
        isNew: false,
        dirty: false,
      };
      setRows(prev => prev.map((row,i) => i===idx ? updated : row));
      setMsg('✅ Période sauvegardée.');
    } catch (e: any) {
      setMsg(`❌ ${e?.message || 'Erreur sauvegarde'}`);
    }
  };

  const deleteRow = async (idx: number) => {
    const r = rows[idx];
    if (r.isNew && !r.id) {
      removeRowLocal(idx);
      return;
    }
    if (!r.id) return;
    const ok = confirm(`Supprimer la période "${r.label}" ?`);
    if (!ok) return;

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      const res = await fetch('/api/admin/periods', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ id: r.id }),
      });
      const json = await parseJsonSafe(res);
      if (!res.ok) throw new Error((json as any)?.error || `HTTP ${res.status}`);
      removeRowLocal(idx);
      setMsg('✅ Période supprimée.');
    } catch (e: any) {
      setMsg(`❌ ${e?.message || 'Erreur suppression'}`);
    }
  };

  const sortedRows = useMemo(() => {
    return [...rows].sort((a,b) => (b.open_at || '').localeCompare(a.open_at || ''));
  }, [rows]);

  return (
    <div className="mx-auto max-w-5xl p-6 space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold text-white">Administration des périodes</h1>
        <div className="ml-auto">
          <button
            onClick={addRow}
            className="px-3 py-1.5 rounded-lg border border-blue-500 text-white bg-blue-600 hover:bg-blue-500"
          >
            + Nouvelle période
          </button>
        </div>
      </div>

      {msg && (
        <div className={`p-3 rounded border ${msg.startsWith('❌') ? 'border-red-700 bg-red-900/30 text-red-200' : 'border-emerald-700 bg-emerald-900/30 text-emerald-200'}`}>
          {msg}
        </div>
      )}

      {loading ? (
        <div className="text-zinc-400">Chargement…</div>
      ) : (
        <div className="space-y-4">
          {sortedRows.length === 0 ? (
            <div className="text-zinc-400">Aucune période.</div>
          ) : sortedRows.map((r, idx) => (
            <div key={(r.id || 'new')+idx} className="rounded-xl border border-zinc-700 bg-zinc-800/60 p-4 space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="text-sm text-zinc-300">
                  Label
                  <input
                    className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-100 px-3 py-2"
                    value={r.label}
                    onChange={(e) => onChangeField(idx, 'label', e.target.value)}
                    placeholder="T4 2025"
                  />
                </label>

                <label className="text-sm text-zinc-300">
                  Fuseau horaire
                  <input
                    className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-100 px-3 py-2"
                    value={r.timezone}
                    onChange={(e) => onChangeField(idx, 'timezone', e.target.value)}
                    placeholder="Europe/Paris"
                  />
                </label>

                <label className="text-sm text-zinc-300">
                  Ouverture (open_at)
                  <input
                    type="datetime-local"
                    className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-100 px-3 py-2"
                    value={r.open_at}
                    onChange={(e) => onChangeField(idx, 'open_at', e.target.value)}
                  />
                </label>

                <label className="text-sm text-zinc-300">
                  Fermeture (close_at)
                  <input
                    type="datetime-local"
                    className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-100 px-3 py-2"
                    value={r.close_at}
                    onChange={(e) => onChangeField(idx, 'close_at', e.target.value)}
                  />
                </label>

                <label className="text-sm text-zinc-300">
                  Tirage (generate_at)
                  <div className="mt-1 flex gap-2">
                    <input
                      type="datetime-local"
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-100 px-3 py-2"
                      value={r.generate_at}
                      onChange={(e) => onChangeField(idx, 'generate_at', e.target.value)}
                    />
                    <button
                      onClick={() => setGenerateMinus15Days(idx)}
                      className="px-3 py-2 rounded-lg border border-zinc-600 text-zinc-100 hover:bg-zinc-700"
                      title="Définir à 15 jours avant l'ouverture"
                    >
                      –15 j
                    </button>
                  </div>
                </label>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => saveRow(idx)}
                  className="px-3 py-1.5 rounded-lg border border-emerald-500 text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50"
                  disabled={!r.dirty}
                >
                  Enregistrer
                </button>
                <button
                  onClick={() => deleteRow(idx)}
                  className="px-3 py-1.5 rounded-lg border border-red-500 text-red-200 hover:bg-red-900/30"
                >
                  Supprimer
                </button>
                {!r.dirty && <span className="text-xs text-zinc-400">À jour</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
