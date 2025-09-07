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

type Period = { id: string; label: string; draw_at?: string | null };

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
  const [drawAt, setDrawAt] = useState<Date | null>(null);
  const [countdown, setCountdown] = useState<string>('');

  const [slots, setSlots] = useState<Slot[]>([]);
  const [availability, setAvailability] = useState<Record<string, boolean>>({});
  const [viewMonth, setViewMonth] = useState<Date | null>(null);
  const [optedOut, setOptedOut] = useState<boolean>(false);
  const [loading, setLoading] = useState(true);

  // autosave silencieux (debounce)
  const debounceRef = useRef<number | null>(null);
  const pendingIdsRef = useRef<Set<string>>(new Set());

  // --------- INIT ---------
  useEffect(() => {
    (async () => {
      setLoading(true);

      // Auth
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.replace('/login'); return; }
      setUserId(user.id);

      // Profil minimal
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
      } else if (!prof.first_name || !prof.last_name) {
        router.replace('/preferences?missing=1');
        return;
      }

      // Périodes (on lit aussi draw_at)
      const { data: periodsData } = await supabase
        .from('periods')
        .select('id,label,draw_at')
        .order('open_at', { ascending: false });

      const list = (periodsData || []) as Period[];
      setPeriods(list);

      const defId = list[0]?.id || '';
      setPeriodId(defId);
      setDrawAt(list[0]?.draw_at ? new Date(list[0]!.draw_at!) : null);

      if (defId) {
        await Promise.all([
          loadSlotsAndAvail(defId, user.id),
          loadOptOut(defId, user.id),
        ]);
      }

      setLoading(false);
    })();
  }, [router]);

  // --------- Compte à rebours ---------
  useEffect(() => {
    if (!drawAt) { setCountdown(''); return; }
    const tick = () => {
      const now = new Date();
      const diff = drawAt.getTime() - now.getTime();
      if (diff <= 0) { setCountdown('Clôturé — le planning n’est plus modifiable.'); return; }
      const d = Math.floor(diff / (24*3600*1000));
      const h = Math.floor((diff % (24*3600*1000)) / (3600*1000));
      const m = Math.floor((diff % (3600*1000)) / (60*1000));
      const s = Math.floor((diff % (60*1000)) / 1000);
      setCountdown(`J-${d} ${pad(h)}:${pad(m)}:${pad(s)}`);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [drawAt]);

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

  const loadOptOut = async (pid: string, uid: string) => {
    const { data } = await supabase
      .from('doctor_period_flags')
      .select('opted_out')
      .eq('user_id', uid)
      .eq('period_id', pid)
      .maybeSingle();
    setOptedOut(!!data?.opted_out);
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

  // Édition autorisée si pas opt-out et avant draw_at
  const isReadOnly = useMemo(() => {
    if (optedOut) return true;
    if (!drawAt) return false;
    return new Date() >= drawAt;
  }, [drawAt, optedOut]);

  // --------- AUTOSAVE (debounce) ---------
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
      // rollback silencieux
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
    if (isReadOnly) return;
    setAvailability(prev => ({ ...prev, [slotId]: !prev[slotId] }));
    pendingIdsRef.current.add(slotId);
    scheduleSave();
  };

  const toggleOptOut = async () => {
    if (!userId || !periodId) return;
    const wantOptOut = !optedOut;
    if (wantOptOut) {
      const ok = confirm('Confirmer : vous ne souhaitez pas prendre de garde ce trimestre ?');
      if (!ok) return;
    }
    await supabase
      .from('doctor_period_flags')
      .upsert({
        user_id: userId,
        period_id: periodId,
        opted_out: wantOptOut,
        all_validated: false,
      }, { onConflict: 'user_id,period_id' });

    setOptedOut(wantOptOut);
  };

  // --------- RENDER ---------
  if (loading) return <p>Chargement…</p>;

  const currentMonthKey = viewMonth ? yyyymm(viewMonth) : '';

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
            const p = periods.find(pp => pp.id === v);
            setDrawAt(p?.draw_at ? new Date(p.draw_at) : null);
            if (userId) {
              await Promise.all([
                loadSlotsAndAvail(v, userId),
                loadOptOut(v, userId),
              ]);
            }
          }}
        >
          {periods.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>

        {monthsInPeriod.map(m => {
          const isActive = currentMonthKey === m.key;

          const activeCls = 'bg-white text-black border border-zinc-300';
          const base = isActive
            ? activeCls
            : 'bg-zinc-100 text-zinc-700 border border-zinc-200 hover:bg-white hover:text-black';

          return (
            <button
              key={m.key}
              className={`px-3 py-1.5 rounded ${base}`}
              onClick={() => setViewMonth(m.date)}
            >
              {m.label}
            </button>
          );
        })}

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={toggleOptOut}
            className={`px-3 py-1.5 rounded border ${
              optedOut
                ? 'bg-amber-100 border-amber-300 text-amber-900 hover:bg-amber-200'
                : 'bg-zinc-100 border-zinc-300 text-zinc-800 hover:bg-zinc-200'
            }`}
          >
            {optedOut ? 'Je souhaite finalement proposer des gardes' : 'Je ne souhaite pas prendre de garde ce trimestre'}
          </button>
        </div>
      </div>

      {/* Bloc explicatif + compte à rebours */}
      <div className="rounded-xl border border-zinc-700 bg-zinc-900/50 p-4 space-y-2">
        <p className="text-sm text-zinc-200">
          Indiquez vos disponibilités en <strong>cliquant</strong> sur les créneaux proposés. 
          Chaque clic active/désactive le créneau (vert = disponible). L’enregistrement est <strong>automatique</strong>.
        </p>
        <p className="text-sm text-zinc-400">
          Vous pouvez modifier vos choix à tout moment <em>jusqu’à la date de tirage</em>. Après le tirage, le planning n’est plus modifiable.
        </p>
        {drawAt && (
          <div className="mt-2 font-semibold text-zinc-100">
            Vous avez jusqu’au {drawAt.toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' })} pour saisir vos disponibilités.
            {countdown && <span className="block mt-1 text-lg">⏳ {countdown}</span>}
          </div>
        )}
        {optedOut && (
          <div className="mt-2 text-amber-300">
            Vous avez indiqué ne pas souhaiter prendre de garde ce trimestre. La grille est désactivée.
          </div>
        )}
        {isReadOnly && !optedOut && (
          <div className="mt-2 text-red-300">
            Le tirage a eu lieu. Le planning est désormais en lecture seule.
          </div>
        )}
      </div>

      {/* Grille mensuelle : clic direct = toggle */}
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
                  const cellClass = on
                    ? (isReadOnly ? 'bg-emerald-700 text-white' : 'bg-emerald-600 text-white hover:bg-emerald-500')
                    : (isReadOnly ? 'bg-zinc-200 text-zinc-500' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200');

                  return (
                    <button
                      key={s.id}
                      type="button"
                      disabled={isReadOnly}
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

      {/* Pas de bouton “Enregistrer” : tout est auto-sauvé */}
    </div>
  );
}
