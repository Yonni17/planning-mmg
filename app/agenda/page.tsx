'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

/**
 * Client Supabase (navigateur)
 */
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

/**
 * Types & helpers d'affichage
 */
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

function formatDateLongFR(ymd: string) {
  const d = new Date(`${ymd}T00:00:00`);
  const day = d.toLocaleDateString('fr-FR', { weekday: 'long' });
  const month = d.toLocaleDateString('fr-FR', { month: 'long' });
  const dd = d.getDate();
  const ddStr = dd === 1 ? '1er' : String(dd);
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return `${cap(day)} ${ddStr} ${month}`;
}
function formatKindRange(kind: SlotKind) {
  const t = KIND_TIME[kind];
  const h = (s: string) => s.replace(':', 'h');
  return `${h(t[0])} - ${h(t[1])}`;
}

/**
 * Données
 */
type Period = { id: string; label: string };
type AgendaRow = {
  date: string; // YYYY-MM-DD
  kind: SlotKind;
  start_ts: string;
  slot_id: string;
  user_id: string | null;
  display_name: string | null;
};

export default function AgendaPage() {
  const [periods, setPeriods] = useState<Period[]>([]);
  const [periodId, setPeriodId] = useState<string>('');
  const [periodLabel, setPeriodLabel] = useState<string>('');
  const [loading, setLoading] = useState(false);

  const [rows, setRows] = useState<AgendaRow[]>([]);
  const [me, setMe] = useState<{ user_id: string; email?: string } | null>(null);

  // Charger périodes + utilisateur connecté
  useEffect(() => {
    (async () => {
      const [{ data: per }, { data: { user } = {} }] = await Promise.all([
        supabase.from('periods').select('id,label').order('open_at', { ascending: false }),
        supabase.auth.getUser().then((r) => r?.data ?? { user: null }),
      ]);

      const ps: Period[] = (per as any) ?? [];
      setPeriods(ps);

      if (ps.length && !periodId) {
        // Par défaut, sélectionne la plus récente
        setPeriodId(ps[0].id);
        setPeriodLabel(ps[0].label);
      }

      if (user) {
        setMe({ user_id: user.id, email: user.email ?? undefined });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Quand la période change → charger l'agenda
  useEffect(() => {
    if (!periodId) return;
    (async () => {
      setLoading(true);

      const cur = periods.find((p) => p.id === periodId);
      setPeriodLabel(cur?.label ?? '');

      // assignments + slots + noms profils (left join)
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

      const rws: AgendaRow[] = (data ?? []).map((r: any) => {
        const constructed =
          [r.profiles?.first_name, r.profiles?.last_name].filter(Boolean).join(' ').trim() || null;
        const full = (r.profiles?.full_name as string | undefined)?.trim() || constructed;
        return {
          date: r.slots?.date as string,
          kind: r.slots?.kind as SlotKind,
          start_ts: r.slots?.start_ts as string,
          slot_id: r.slots?.id as string,
          user_id: (r.user_id as string) ?? null,
          display_name: full,
        };
      });

      rws.sort(
        (a, b) =>
          String(a.date).localeCompare(String(b.date)) ||
          String(a.kind).localeCompare(String(b.kind))
      );

      setRows(rws);
      setLoading(false);
    })();
  }, [periodId, periods]);

  // Groupement par jour (facultatif, juste pour un affichage plus sympa)
  const byDay = useMemo(() => {
    const m = new Map<string, AgendaRow[]>();
    for (const r of rows) {
      const k = r.date;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

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

        <div className="text-xs text-zinc-500 md:ml-auto">
          {me?.email ? <>Connecté en tant que <span className="font-medium">{me.email}</span></> : null}
        </div>
      </div>

      <div className="rounded-md border">
        {loading ? (
          <div className="p-4 text-sm text-zinc-500">Chargement…</div>
        ) : !rows.length ? (
          <div className="p-4 text-sm text-zinc-500">Aucune garde pour cette période.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-zinc-900/60">
              <tr>
                <th className="p-2 text-left font-semibold">Date</th>
                <th className="p-2 text-left font-semibold">Créneau</th>
                <th className="p-2 text-left font-semibold">Médecin</th>
              </tr>
            </thead>
            <tbody>
              {byDay.map(([date, dayRows]) => (
                dayRows.map((r, idx) => {
                  const isMe = !!(me?.user_id && r.user_id && me.user_id === r.user_id);
                  // surlignage si créneau de l'utilisateur
                  const trClass = isMe
                    ? 'bg-amber-50/80 dark:bg-amber-900/30'
                    : idx % 2 === 0
                      ? 'bg-white dark:bg-zinc-900/30'
                      : 'bg-gray-50 dark:bg-zinc-900/10';
                  const leftBorder = isMe ? 'border-l-4 border-amber-400' : 'border-l-4 border-transparent';

                  return (
                    <tr key={`${r.slot_id}-${idx}`} className={`${trClass} ${leftBorder}`}>
                      <td className="p-2 align-middle">
                        <span className={isMe ? 'font-semibold text-amber-700 dark:text-amber-300' : ''}>
                          {formatDateLongFR(date)}
                        </span>
                      </td>
                      <td className="p-2 align-middle">{formatKindRange(r.kind)}</td>
                      <td className="p-2 align-middle">
                        <span className={isMe ? 'font-semibold text-amber-700 dark:text-amber-300' : ''}>
                          {r.display_name ?? '—'}
                          {isMe ? ' (vous)' : ''}
                        </span>
                      </td>
                    </tr>
                  );
                })
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-xs text-zinc-500">
        Astuce : vos créneaux sont <span className="font-semibold text-amber-700 dark:text-amber-300">surlignés</span> avec une barre gauche <span className="font-semibold text-amber-700 dark:text-amber-300">ambrée</span>.
      </p>
    </div>
  );
}
