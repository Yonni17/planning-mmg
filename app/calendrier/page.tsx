'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useRouter } from 'next/navigation';

type Slot = {
  id: string;
  period_id: string;
  date: string;      // YYYY-MM-DD
  start_ts: string;
  end_ts: string;
  kind: 'WEEKDAY_20_00'|'SAT_12_18'|'SAT_18_00'|'SUN_08_14'|'SUN_14_20'|'SUN_20_24';
};
type Period = {
  id: string;
  label: string;
  open_at: string;
  close_at: string;
  generate_at: string;
  timezone: string | null;
};

const pad = (n: number) => String(n).padStart(2, '0');
const yyyymm = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const ymdLocal = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const frMonthLabel = (d: Date) => d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });

const KIND_LABEL: Record<Slot['kind'], string> = {
  WEEKDAY_20_00: '20:00–00:00',
  SAT_12_18:     '12:00–18:00',
  SAT_18_00:     '18:00–00:00',
  SUN_08_14:     '08:00–14:00',
  SUN_14_20:     '14:00–20:00',
  SUN_20_24:     '20:00–00:00',
};

export default function CalendrierPage() {
  const router = useRouter();

  const [userId, setUserId] = useState<string | null>(null);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [periodId, setPeriodId] = useState<string>('');
  const [periodMap, setPeriodMap] = useState<Record<string, Period>>({});

  const [slots, setSlots] = useState<Slot[]>([]);
  const [availability, setAvailability] = useState<Record<string, boolean>>({});
  const [viewMonth, setViewMonth] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);

  // autosave silencieux (debounce)
  const debounceRef = useRef<number | null>(null);
  const pendingIdsRef = useRef<Set<string>>(new Set());

  // --------- INIT ---------
  useEffect(() => {
    (async () => {
      setLoading(true);

      // 1) Auth
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.replace('/login'); return; }
      setUserId(user.id);

      // 2) Profil minimal (au cas où)
      const { data: prof } = await supabase
        .from('profiles')
        .select('user_id, first_name, last_name, role')
        .eq('user_id', user.id)
        .maybeSingle();

      if (!prof) {
        await supabase.from('profiles').insert({
          user_id: user.id,
          first_name: null,
          last_name: null,
          role: 'doctor',
        } as any);
      } else {
        if (!prof.first_name || !prof.last_name) {
          router.replace('/preferences?missing=1');
          return;
        }
      }

      // 3) Périodes (⚠️ on lit open_at/close_at)
      const { data: periodsData, error: perr } = await supabase
        .from('periods')
        .select('id,label,open_at,close_at,generate_at,timezone')
        .order('open_at', { ascending: false });
      if (perr) { setLoading(false); return; }

      const list = periodsData || [];
      setPeriods(list);
      setPeriodMap(Object.fromEntries(list.map(p => [p.id, p])));

      const defId = list[0]?.id || '';
      setPeriodId(defId);

      if (defId) {
        await Promise.all([
          loadSlotsAndAvail(defId, user.id),
        ]);
        // Mois par défaut : début de période (même s'il n'y a pas encore de slots)
        const p = list.find(x => x.id === defId)!;
        const start = new Date(p.open_at);
        setViewMonth(new Date(start.getFullYear(), start.getMonth(), 1));
      }
      setLoading(false);
    })();
  }, [router]);

  // --------- LOADERS ---------
  const loadSlotsAndAvail = async (pid: string, uid: string) => {
    const { data: slotsData } = await supabase
      .from('slots')
      .select('id, period_id, date, start_ts, end_ts, kind')
      .eq('period_id', pid)
      .order('start_ts', { ascending: true });

    const sList = (slotsData || []) as Slot[];
    setSlots(sList);

    const { data: avData } = await supabase
      .from('availability')
      .select('slot_id, available')
      .eq('user_id', uid);

    const map: Record<string, boolean> = {};
    for (const row of avData || []) map[(row as any).slot_id as string] = !!(row as any).available;
    setAvailability(map);

    pendingIdsRef.current = new Set();
  };

  // --------- DERIVED ---------
  // fallback mois: si pas de slots, on construit les mois depuis open_at..close_at
  const monthsInView = useMemo(() => {
    if (!periodId) return [];
    const p = periodMap[periodId];
    if (!p) return [];

    const bySlots = (() => {
      const set = new Set<string>();
      for (const s of slots) set.add(yyyymm(new Date(s.date + 'T00:00:00')));
      if (set.size === 0) return null;
      return Array.from(set).sort().map(m => {
        const d = new Date(m + '-01T00:00:00');
        return { key: m, date: d, label: frMonthLabel(d) };
      });
    })();

    if (bySlots) return bySlots;

    // Aucun slot → construire mois entre open_at et close_at
    const start = new Date(p.open_at);
    const end = new Date(p.close_at);
    const months: { key: string; date: Date; label: string }[] = [];
    const cur = new Date(start.getFullYear(), start.getMonth(), 1);
    const endKey = new Date(end.getFullYear(), end.getMonth(), 1).getTime();

    while (cur.getTime() <= endKey) {
      const key = yyyymm(cur);
      months.push({ key, date: new Date(cur), label: frMonthLabel(cur) });
      cur.setMonth(cur.getMonth() + 1);
    }
    return months;
  }, [periodId, periodMap, slots]);

  const daysOfMonth = useMemo(() => {
    if (!viewMonth) return [];
    const y = viewMonth.getFullYear();
    const m = viewMonth.getMonth();
    const first = new Date(y, m, 1);
    const last = new Date(y, m + 1, 0);
    const firstWeekday = (first.getDay() + 6) % 7; // 0=Lun ... 6=Dim
    const cells: (Date | null)[] = [];
    for (let i = 0; i < firstWeekday; i++) cells.push(null);
    for (let d = 1; d <= last.getDate(); d++) cells.push(new Date(y, m, d));
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [viewMonth]);

  const slotsByDate = useMemo(() => {
    const map: Record<string, Slot[]> = {};
    for (const s of slots) (map[s.date] ||= []).push(s);
    Object.values(map).forEach(list => list.sort((a, b) => +new Date(a.start_ts) - +new Date(b.start_ts)));
    return map;
  }, [slots]);

  // --------- AUTOSAVE silencieux ---------
  const flushSave = async () => {
    if (!userId) return;
    const ids = Array.from(pendingIdsRef.current);
    if (ids.length === 0) return;

    const payload = ids.map(slot_id => ({
      user_id: userId,
      slot_id,
      available: !!availability[slot_id],
    }));

    try {
      const { error } = await supabase.from('availability').upsert(payload);
      if (error) throw error;
      pendingIdsRef.current = new Set();
    } catch {
      // rollback local si erreur
      setAvailability(prev => {
        const copy = { ...prev };
        for (const slot_id of ids) copy[slot_id] = !copy[slot_id];
        return copy;
      });
      pendingIdsRef.current = new Set();
    }
  };
  const scheduleSave = () => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(flushSave, 500);
  };

  // --------- ACTIONS ---------
  const toggleLocal = (slotId: string) => {
    setAvailability(prev => ({ ...prev, [slotId]: !prev[slotId] }));
    pendingIdsRef.current.add(slotId);
    scheduleSave();
  };

  // --------- RENDER ---------
  if (loading) return <p>Chargement…</p>;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Mes disponibilités</h1>

      {/* Sélecteurs période & mois */}
      <div className="flex flex-wrap gap-2 items-center">
        <select
          className="border rounded p-2 bg-zinc-900 text-zinc-100 border-zinc-700"
          value={periodId}
          onChange={async (e) => {
            const v = e.target.value;
            setPeriodId(v);
            if (userId) {
              await loadSlotsAndAvail(v, userId);
              const p = periodMap[v] || periods.find(pp => pp.id === v);
              if (p) {
                const start = new Date(p.open_at);
                setViewMonth(new Date(start.getFullYear(), start.getMonth(), 1));
              }
            }
          }}
        >
          {periods.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>

        {monthsInView.map(m => {
          const isActive = viewMonth && yyyymm(viewMonth) === m.key;
          const cls = isActive
            ? 'bg-white text-black border border-zinc-300'
            : 'bg-zinc-100 text-zinc-700 border border-zinc-200 hover:bg-white hover:text-black';
        return (
            <button
              key={m.key}
              className={`px-3 py-1.5 rounded ${cls}`}
              onClick={() => setViewMonth(m.date)}
            >
              {m.label}
            </button>
          );
        })}
      </div>

      {/* Message explicatif */}
      {periodId && (
        <div className="rounded-lg border border-zinc-700 bg-zinc-800/40 p-3 text-sm text-zinc-200">
          Sélectionnez vos créneaux disponibles en cliquant directement sur les cases vertes.
          Les modifications sont enregistrées automatiquement.
          S’il n’y a pas de créneau un jour donné, la case affiche « Aucun créneau ».
        </div>
      )}

      {/* Grille mensuelle */}
      <div className="grid grid-cols-7 gap-2">
        {['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'].map(w => (
          <div key={w} className="text-center text-xs uppercase tracking-wide text-gray-500">{w}</div>
        ))}

        {daysOfMonth.map((d, i) => {
          if (!d) return <div key={i} className="h-32 rounded-xl border border-dashed border-gray-200 bg-gray-50" />;

          const key = ymdLocal(d);
          const daySlots = slotsByDate[key] || [];
          const dayNum = d.getDate();

          return (
            <div
              key={i}
              className="h-32 rounded-2xl border border-gray-200 overflow-hidden bg-white shadow-sm text-left"
            >
              <div className="px-2 pt-2 pb-1 text-sm font-medium text-gray-700 flex items-center justify-between">
                <span>{dayNum}</span>
                <span className="text-xs text-gray-400">
                  {d.toLocaleDateString('fr-FR', { weekday: 'short' })}
                </span>
              </div>

              <div className="flex flex-col h-[calc(100%-2rem)]">
                {daySlots.length === 0 ? (
                  <div className="flex-1 text-xs px-2 text-gray-400 flex items-center justify-center">Aucun créneau</div>
                ) : daySlots.map((s) => {
                  const on = !!availability[s.id];
                  const onCls  = 'bg-emerald-600 text-white hover:bg-emerald-500';
                  const offCls = 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200';
                  const cellClass  = on ? onCls : offCls;

                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => toggleLocal(s.id)}
                      className={`flex-1 text-[11px] px-2 border-t first:border-t-0 ${cellClass} flex items-center justify-center`}
                      title={KIND_LABEL[s.kind]}
                    >
                      {KIND_LABEL[s.kind]}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
