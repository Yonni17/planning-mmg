'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type SlotKind =
  | 'WEEKDAY_20_00'
  | 'SAT_12_18'
  | 'SAT_18_00'
  | 'SUN_08_14'
  | 'SUN_14_20'
  | 'SUN_20_24';

const KIND_TIME: Record<SlotKind, [string, string]> = {
  WEEKDAY_20_00: ['20:00', '00:00'],
  SAT_12_18: ['12:00', '18:00'],
  SAT_18_00: ['18:00', '00:00'],
  SUN_08_14: ['08:00', '14:00'],
  SUN_14_20: ['14:00', '20:00'],
  SUN_20_24: ['20:00', '00:00'],
};

function hmsToFR(s: string) {
  return s.replace(':', 'h');
}
function kindToRange(kind: SlotKind) {
  const [a, b] = KIND_TIME[kind];
  return `${hmsToFR(a)} - ${hmsToFR(b)}`;
}
function formatDateLongFR(ymd: string) {
  const d = new Date(`${ymd}T00:00:00`);
  const day = d.toLocaleDateString('fr-FR', { weekday: 'long' });
  const month = d.toLocaleDateString('fr-FR', { month: 'long' });
  const dd = d.getDate();
  const ddStr = dd === 1 ? '1er' : String(dd);
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
  return `${cap(day)} ${ddStr} ${month}`;
}

type Period = { id: string; label: string };
type Row = {
  slot_id: string;
  date: string;
  kind: SlotKind;
  user_id: string | null;
  display_name: string | null;
};

export default function AgendaPage() {
  const [periods, setPeriods] = useState<Period[]>([]);
  const [periodId, setPeriodId] = useState('');
  const [periodLabel, setPeriodLabel] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [meId, setMeId] = useState<string | null>(null);

  // charge périodes + user courant
  useEffect(() => {
    (async () => {
      const [{ data: per }, auth] = await Promise.all([
        supabase.from('periods').select('id,label').order('open_at', { ascending: false }),
        supabase.auth.getUser(),
      ]);
      const list: Period[] = (per as any) ?? [];
      setPeriods(list);
      if (list.length && !periodId) {
        setPeriodId(list[0].id);
        setPeriodLabel(list[0].label);
      }
      const uid = auth?.data?.user?.id ?? null;
      setMeId(uid);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // charge agenda pour la période
  useEffect(() => {
    if (!periodId) return;
    (async () => {
      setLoading(true);

      const cur = periods.find((p) => p.id === periodId);
      setPeriodLabel(cur?.label ?? '');

      const { data, error } = await supabase
        .from('assignments')
        .select(`
          slot_id,
          user_id,
          slots!inner(id, date, kind, start_ts),
          profiles!assignments_user_id_fkey(user_id, full_name, first_name, last_name)
        `)
        .eq('period_id', periodId)
        .order('slots(start_ts)', { ascending: true });

      if (error) {
        console.error('[agenda] load error', error);
        setRows([]);
        setLoading(false);
        return;
      }

      const rws: Row[] = (data ?? []).map((r: any) => {
        const built = [r.profiles?.first_name, r.profiles?.last_name].filter(Boolean).join(' ').trim() || null;
        const full = (r.profiles?.full_name as string | undefined)?.trim() || built;
        return {
          slot_id: r.slots?.id as string,
          date: r.slots?.date as string,
          kind: r.slots?.kind as SlotKind,
          user_id: (r.user_id as string) ?? null,
          display_name: full,
        };
      });

      setRows(rws);
      setLoading(false);
    })();
  }, [periodId, periods]);

  const table = useMemo(() => {
    if (!rows.length) return null;

    return (
      <table className="w-full text-sm">
        <thead className="bg-gray-50 dark:bg-zinc-900/60">
          <tr>
            <th className="p-2 text-left font-semibold">Date</th>
            <th className="p-2 text-left font-semibold">Créneau</th>
            <th className="p-2 text-left font-semibold">Médecin</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const isMe = !!(meId && r.user_id && meId === r.user_id);

            // on garde le même rendu, avec zebra; si c'est "moi", on force un fond + bordure gauche
            const zebra =
              i % 2 === 0
                ? 'bg-white dark:bg-zinc-900/30'
                : 'bg-gray-50 dark:bg-zinc-900/10';

            const highlight =
              'ring-1 ring-amber-500/30 !bg-amber-50 dark:!bg-amber-900/30 border-l-4 border-amber-400';

            return (
              <tr
                key={r.slot_id}
                className={`${zebra} ${isMe ? highlight : 'border-l-4 border-transparent'}`}
                style={isMe ? { backgroundColor: 'rgba(245, 158, 11, 0.1)' } : undefined} // secours si le theme override
              >
                <td className="p-2 align-middle">
                  <span className={isMe ? 'font-semibold text-amber-700 dark:text-amber-300' : undefined}>
                    {formatDateLongFR(r.date)}
                  </span>
                </td>
                <td className="p-2 align-middle">{kindToRange(r.kind)}</td>
                <td className="p-2 align-middle">
                  <span className={isMe ? 'font-semibold text-amber-700 dark:text-amber-300' : undefined}>
                    {r.display_name ?? '—'}{isMe ? ' (vous)' : ''}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }, [rows, meId]);

  return (
    <div className="mx-auto max-w-5xl p-4 space-y-6">
      <h1 className="text-2xl font-bold">Agenda MMG</h1>

      <div className="flex flex-col gap-3 md:flex-row md:items-end">
        <div className="flex flex-col">
          <label className="text-sm font-medium mb-1">Période</label>
          <select
            value={periodId}
            onChange={(e) => setPeriodId(e.target.value)}
            className="w-full md:w-auto rounded-lg border px-3 py-2 text-gray-900 bg-white dark:bg-zinc-900 dark:text-zinc-100"
          >
            {periods.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
          {periodLabel ? (
            <p className="text-xs text-zinc-500 mt-1">Période sélectionnée : {periodLabel}</p>
          ) : null}
        </div>
      </div>

      <div className="rounded-md border">
        {loading ? (
          <div className="p-4 text-sm text-zinc-500">Chargement…</div>
        ) : !rows.length ? (
          <div className="p-4 text-sm text-zinc-500">Aucune garde pour cette période.</div>
        ) : (
          table
        )}
      </div>

      <p className="text-xs text-zinc-500">
        Astuce : vos créneaux sont <span className="font-semibold text-amber-700 dark:text-amber-300">surlignés</span> et marqués d’une barre gauche ambrée.
      </p>
    </div>
  );
}
