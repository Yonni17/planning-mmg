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

type Period = { id: string; label: string };

type MonthStatus = {
  validated_at: string | null;
  locked: boolean;
  opted_out: boolean | null;
};

type Profile = {
  user_id: string;
  first_name: string | null;
  last_name: string | null;
  role: string | null;
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
  const [slots, setSlots] = useState<Slot[]>([]);
  const [availability, setAvailability] = useState<Record<string, boolean>>({});
  const [monthStatus, setMonthStatus] = useState<Record<string, MonthStatus>>({});
  const [viewMonth, setViewMonth] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);

  // autosave silencieux (debounce)
  const debounceRef = useRef<number | null>(null);
  const pendingIdsRef = useRef<Set<string>>(new Set()); // set des slot_id modifiés depuis la dernière save

  // --------- INIT ---------
  useEffect(() => {
    (async () => {
      setLoading(true);

      // 1) Auth
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.replace('/login'); return; }
      setUserId(user.id);

      // 2) S’assurer qu’un profil existe (FK éventuel)
      const { data: prof } = await supabase
        .from('profiles')
        .select('user_id, first_name, last_name, role')
        .eq('user_id', user.id)
        .maybeSingle();

      if (!prof) {
        // crée un profil minimal silencieusement (aucun message UI)
        await supabase.from('profiles').insert({
          user_id: user.id,
          first_name: null,
          last_name: null,
          role: 'doctor',
        } as any);
      } else {
        // si prénom/nom manquants → on force la complétion d’identité
        if (!prof.first_name || !prof.last_name) {
          router.replace('/preferences?missing=1');
          return;
        }
      }

      // 3) Périodes
      const { data: periodsData, error: perr } = await supabase
        .from('periods')
        .select('id,label')
        .order('open_at', { ascending: false });
      if (perr) { setLoading(false); return; }

      const list = periodsData || [];
      setPeriods(list);

      const defId = list[0]?.id || '';
      setPeriodId(defId);

      if (defId) {
        await Promise.all([
          loadSlotsAndAvail(defId, user.id),
          loadMonthStatus(defId, user.id),
        ]);
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

    if (!viewMonth && sList.length > 0) {
      const d0 = new Date(sList[0].date + 'T00:00:00');
      setViewMonth(new Date(d0.getFullYear(), d0.getMonth(), 1));
    }

    const { data: avData } = await supabase
      .from('availability')
      .select('slot_id, available')
      .eq('user_id', uid);

    const map: Record<string, boolean> = {};
    for (const row of avData || []) map[(row as any).slot_id as string] = !!(row as any).available;
    setAvailability(map);

    pendingIdsRef.current = new Set();
  };

  const loadMonthStatus = async (pid: string, uid: string) => {
    const { data } = await supabase
      .from('doctor_period_months')
      .select('month, validated_at, locked, opted_out')
      .eq('user_id', uid)
      .eq('period_id', pid);

    const m: Record<string, MonthStatus> = {};
    for (const row of data || []) {
      m[(row as any).month as string] = {
        validated_at: (row as any).validated_at as string | null,
        locked: !!(row as any).locked,
        opted_out: ((row as any).opted_out as boolean | null) ?? null,
      };
    }
    setMonthStatus(m);
  };

  // --------- DERIVED ---------
  const monthsInPeriod = useMemo(() => {
    const set = new Set<string>();
    for (const s of slots) set.add(yyyymm(new Date(s.date + 'T00:00:00')));
    return Array.from(set).sort().map(m => {
      const d = new Date(m + '-01T00:00:00');
      return { key: m, date: d, label: frMonthLabel(d) };
    });
  }, [slots]);

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

  const currentMonthKey = useMemo(() => viewMonth ? yyyymm(viewMonth) : '', [viewMonth]);

  // --------- AUTOSAVE (debounce) ---------
  const flushSave = async () => {
    if (!userId) return;
    const ids = Array.from(pendingIdsRef.current);
    if (ids.length === 0) return;

    // snapshot changes
    const payload = ids.map(slot_id => ({
      user_id: userId,
      slot_id,
      available: !!availability[slot_id],
    }));

    // on tente la sauvegarde ; en cas d’échec on rollback localement
    try {
      const { error } = await supabase.from('availability').upsert(payload);
      if (error) throw error;

      pendingIdsRef.current = new Set(); // ok
    } catch {
      // rollback silencieux
      setAvailability(prev => {
        const copy = { ...prev };
        for (const slot_id of ids) {
          copy[slot_id] = !copy[slot_id];
        }
        return copy;
      });
      pendingIdsRef.current = new Set(); // reset quand même
    }
  };

  const scheduleSave = () => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(flushSave, 500);
  };

  // --------- ACTIONS ---------
  const toggleLocal = (slotId: string, locked: boolean) => {
    if (locked) return; // si mois verrouillé : pas de modif
    setAvailability(prev => {
      const next = { ...prev, [slotId]: !prev[slotId] };
      return next;
    });
    pendingIdsRef.current.add(slotId);
    scheduleSave();
  };

  const validateMonth = async (mKey: string) => {
    if (!userId || !periodId) return;
    await supabase
      .from('doctor_period_months')
      .upsert({
        user_id: userId,
        period_id: periodId,
        month: mKey,
        locked: true,
        validated_at: new Date().toISOString(),
        opted_out: false,
      }, { onConflict: 'user_id,period_id,month' });
    await loadMonthStatus(periodId, userId);
  };

  const unlockMonth = async (mKey: string) => {
    if (!userId || !periodId) return;
    const ok = confirm('Déverrouiller ce mois pour modifier vos disponibilités ?');
    if (!ok) return;
    await supabase
      .from('doctor_period_months')
      .upsert({
        user_id: userId,
        period_id: periodId,
        month: mKey,
        locked: false,
        validated_at: null,
      }, { onConflict: 'user_id,period_id,month' });
    await loadMonthStatus(periodId, userId);
  };

  // --------- RENDER ---------
  if (loading) return <p>Chargement…</p>;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Mes disponibilités</h1>

      {/* Sélecteurs période & mois */}
      <div className="flex flex-wrap gap-2 items-center">
        <select
          className="border rounded p-2 bg-white text-gray-600 border-zinc-300"
          value={periodId}
          onChange={async (e) => {
            const v = e.target.value;
            setPeriodId(v);
            if (userId) {
              await Promise.all([
                loadSlotsAndAvail(v, userId),
                loadMonthStatus(v, userId),
              ]);
            }
          }}
        >
          {periods.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>

        {monthsInPeriod.map(m => {
          const st = monthStatus[m.key];
          const isActive = currentMonthKey === m.key;

          const activeCls = 'bg-white text-black border border-zinc-300';
          const greenCls  = 'bg-green-50 text-green-900 border border-green-200';
          const redCls    = 'bg-red-50 text-red-900 border border-red-200';
          const hoverCls  = 'hover:bg-white hover:text-black';

          const base = isActive
            ? activeCls
            : (st?.locked ? `${greenCls} ${hoverCls}` : `${redCls} ${hoverCls}`);

          return (
            <button
              key={m.key}
              className={`px-3 py-1.5 rounded ${base}`}
              onClick={() => setViewMonth(m.date)}
              title={st?.locked ? 'Validé' : 'À valider'}
            >
              {m.label}
            </button>
          );
        })}

        {/* Actions mois courant (silencieuses) */}
        {!!currentMonthKey && (
          <div className="ml-auto flex items-center gap-2">
            {monthStatus[currentMonthKey]?.locked ? (
              <>
                <span className="text-sm text-green-700">Mois validé</span>
                <button
                  className="px-3 py-1.5 rounded border border-zinc-300 hover:bg-zinc-50"
                  onClick={() => unlockMonth(currentMonthKey)}
                >
                  Déverrouiller
                </button>
              </>
            ) : (
              <>
                <span className="text-sm text-red-700">Mois à valider</span>
                <button
                  className="px-3 py-1.5 rounded border border-emerald-300 text-emerald-900 bg-emerald-50 hover:bg-emerald-100"
                  onClick={() => validateMonth(currentMonthKey)}
                >
                  Valider ce mois
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Grille mensuelle : clic direct = toggle (pas de sheet, pas de bandeau) */}
      <div className="grid grid-cols-7 gap-2">
        {['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'].map(w => (
          <div key={w} className="text-center text-xs uppercase tracking-wide text-gray-500">{w}</div>
        ))}

        {daysOfMonth.map((d, i) => {
          if (!d) return <div key={i} className="h-32 rounded-xl border border-dashed border-gray-200 bg-gray-50" />;

          const key = ymdLocal(d);
          const daySlots = slotsByDate[key] || [];
          const dayNum = d.getDate();
          const mKey = yyyymm(d);
          const locked = !!monthStatus[mKey]?.locked;

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
                  const cellClass = on
                    ? (locked ? 'bg-emerald-700 text-white' : 'bg-emerald-600 text-white hover:bg-emerald-500')
                    : (locked ? 'bg-zinc-200 text-zinc-500' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200');

                  return (
                    <button
                      key={s.id}
                      type="button"
                      disabled={locked}
                      onClick={() => toggleLocal(s.id, locked)}
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

      {/* Pas de bouton “Enregistrer” ni de bandeau : tout est auto-sauvé en silence */}
    </div>
  );
}