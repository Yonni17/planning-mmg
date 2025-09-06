// app/calendrier/page.tsx
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useRouter } from 'next/navigation';

type Slot = {
  id: string;
  period_id: string;
  date: string;      // YYYY-MM-DD (locale)
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
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // --- état pour le "batch + debounce" ---
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- bottom sheet (mobile) ---
  const [openDay, setOpenDay] = useState<string | null>(null); // YYYY-MM-DD

  // --------- INIT ---------
  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.replace('/login'); return; }
      setUserId(user.id);

      const { data: periodsData, error: pErr } = await supabase
        .from('periods')
        .select('id,label')
        .order('open_at', { ascending: false });
      if (pErr) { setMsg(`Erreur périodes: ${pErr.message}`); setLoading(false); return; }

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
    setMsg(null);

    const { data: slotsData, error: sErr } = await supabase
      .from('slots')
      .select('id, period_id, date, start_ts, end_ts, kind')
      .eq('period_id', pid)
      .order('start_ts', { ascending: true });
    if (sErr) { setMsg(`Erreur slots: ${sErr.message}`); return; }
    const sList = (slotsData || []) as Slot[];
    setSlots(sList);

    if (!viewMonth && sList.length > 0) {
      const d0 = new Date(sList[0].date + 'T00:00:00');
      setViewMonth(new Date(d0.getFullYear(), d0.getMonth(), 1));
    }

    // Toutes les dispos de l'utilisateur
    const { data: avData, error: aErr } = await supabase
      .from('availability')
      .select('slot_id, available')
      .eq('user_id', uid);
    if (aErr) { setMsg(`Erreur availability: ${aErr.message}`); return; }
    const map: Record<string, boolean> = {};
    for (const row of avData || []) map[row.slot_id as string] = !!row.available;
    setAvailability(map);
  };

  const loadMonthStatus = async (pid: string, uid: string) => {
    const { data, error } = await supabase
      .from('doctor_period_months')
      .select('month, validated_at, locked, opted_out')
      .eq('user_id', uid)
      .eq('period_id', pid);
    if (error) { setMsg(`Erreur statut mois: ${error.message}`); return; }
    const m: Record<string, MonthStatus> = {};
    for (const row of data || []) {
      m[row.month as string] = {
        validated_at: row.validated_at as string | null,
        locked: !!row.locked,
        opted_out: (row.opted_out as boolean | null) ?? null,
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

  // --------- BATCH SAVE (debounce 800ms) ---------
  const flushPending = async () => {
    if (!userId) return;
    const entries = Object.entries(pending);
    if (entries.length === 0) return;

    try {
      const rows = entries.map(([slot_id, available]) => ({
        user_id: userId!,
        slot_id,
        available,
      }));
      const { error } = await supabase.from('availability').upsert(rows);
      if (error) throw error;
      setPending({});
      setMsg('✔️ Modifications enregistrées.');
    } catch (e: any) {
      setMsg(`❌ Sauvegarde: ${e.message ?? e}`);
    }
  };

  // déclenchement auto après 800ms sans nouveau clic
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (Object.keys(pending).length === 0) return;
    debounceRef.current = setTimeout(() => { flushPending(); }, 800);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(pending)]);

  // --------- ACTIONS ---------
  const toggleLocal = (slotId: string, target?: boolean) => {
    // trouve le mois du slot → si verrouillé, on bloque
    const slot = slots.find(s => s.id === slotId);
    if (!slot) return;
    const mKey = yyyymm(new Date(slot.date + 'T00:00:00'));
    if (monthStatus[mKey]?.locked) {
      alert('Ce mois est validé. Déverrouillez-le pour modifier vos disponibilités.');
      return;
    }

    setAvailability(prev => {
      const nextVal = target ?? !prev[slotId];
      const next = { ...prev, [slotId]: nextVal };
      // marque comme "à envoyer"
      setPending(p => ({ ...p, [slotId]: nextVal }));
      return next;
    });
  };

  const validateMonth = async (mKey: string) => {
    if (!userId || !periodId) return;
    // upsert (user_id, period_id, month) → locked = true, validated_at = now
    const { error } = await supabase
      .from('doctor_period_months')
      .upsert({
        user_id: userId,
        period_id: periodId,
        month: mKey,
        locked: true,
        validated_at: new Date().toISOString(),
        opted_out: false,
      }, { onConflict: 'user_id,period_id,month' });
    if (error) { setMsg(`❌ Validation: ${error.message}`); return; }
    await loadMonthStatus(periodId, userId);
    setMsg('✅ Mois validé.');
  };

  const unlockMonth = async (mKey: string) => {
    if (!userId || !periodId) return;
    const ok = confirm('Déverrouiller ce mois pour modifier vos disponibilités ?');
    if (!ok) return;
    const { error } = await supabase
      .from('doctor_period_months')
      .upsert({
        user_id: userId,
        period_id: periodId,
        month: mKey,
        locked: false,
        validated_at: null,
      }, { onConflict: 'user_id,period_id,month' });
    if (error) { setMsg(`❌ Déverrouillage: ${error.message}`); return; }
    await loadMonthStatus(periodId, userId);
    setMsg('🔓 Mois déverrouillé.');
  };

  // --------- RENDER ---------
  if (loading) return <p>Chargement…</p>;

  const pendingCount = Object.keys(pending).length;

  return (
    <div className="space-y-4 pb-[calc(env(safe-area-inset-bottom)+64px)]">
      <h1 className="text-xl font-semibold">Mes disponibilités</h1>

      {/* Sélecteurs période & mois */}
      <div className="flex flex-wrap gap-2 items-center">
        <select
          className="border rounded p-2"
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

        {/* Actions mois courant */}
        {!!currentMonthKey && (
          <div className="ml-auto flex items-center gap-2">
            {monthStatus[currentMonthKey]?.locked ? (
              <>
                <span className="text-sm text-green-700">Ce mois est validé ✅</span>
                <button
                  className="px-3 py-1.5 rounded border border-zinc-300 hover:bg-zinc-50"
                  onClick={() => unlockMonth(currentMonthKey)}
                >
                  Déverrouiller
                </button>
              </>
            ) : (
              <>
                <span className="text-sm text-red-700">Ce mois n’est pas validé</span>
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

      {msg && (
        <div className={`p-3 rounded border ${msg.startsWith('❌') ? 'bg-red-50 border-red-200 text-red-900' : 'bg-gray-50 border-gray-200 text-gray-800'}`}>
          {msg}
        </div>
      )}

      {/* Grille mensuelle */}
      <div className="grid grid-cols-7 gap-2 md:gap-3">
        {['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'].map(w => (
          <div key={w} className="text-center text-xs uppercase tracking-wide text-gray-500">{w}</div>
        ))}

        {daysOfMonth.map((d, i) => {
          if (!d) return (
            <div key={i} className="h-24 md:h-32 rounded-xl border border-dashed border-gray-200 bg-gray-50" />
          );

          const key = ymdLocal(d);
          const daySlots = slotsByDate[key] || [];
          const dayNum = d.getDate();
          const mKey = yyyymm(d);
          const locked = !!monthStatus[mKey]?.locked;

          // sur mobile : toucher la carte ouvre la bottom-sheet
          const openSheet = () => {
            if (daySlots.length === 0) return;
            setOpenDay(key);
          };

          return (
            <div
              key={i}
              className="h-24 md:h-32 rounded-2xl border border-gray-200 overflow-hidden bg-white shadow-sm"
            >
              <button
                onClick={openSheet}
                className="px-2 pt-2 pb-1 text-sm font-medium text-gray-700 w-full flex items-center justify-between md:cursor-default"
              >
                <span>{dayNum}</span>
                <span className="text-xs text-gray-400">{d.toLocaleDateString('fr-FR', { weekday: 'short' })}</span>
              </button>

              {/* desktop: boutons directement cliquables */}
              <div className="hidden md:flex flex-col h-[calc(100%-2rem)]">
                {daySlots.length === 0 ? (
                  <div className="flex-1 text-xs px-2 text-gray-400 flex items-center justify-center">Aucun créneau</div>
                ) : daySlots.map((s) => {
                  const on = !!availability[s.id];
                  const onCls  = locked ? 'bg-green-600 text-white cursor-not-allowed' : 'bg-green-500 text-white';
                  const offCls = locked ? 'bg-white text-gray-400 cursor-not-allowed' : 'bg-white hover:bg-gray-50 text-gray-700';
                  const cellClass  = on ? onCls : offCls;

                  const handleClick = () => {
                    if (locked) {
                      alert('Mois validé : déverrouillez pour modifier vos disponibilités.');
                      return;
                    }
                    toggleLocal(s.id);
                  };

                  return (
                    <button
                      key={s.id}
                      onClick={handleClick}
                      className={`flex-1 text-xs px-2 border-t first:border-t-0 focus:outline-none transition-colors ${cellClass}`}
                      title={KIND_LABEL[s.kind]}
                    >
                      <div className="h-full w-full flex items-center justify-center">
                        {KIND_LABEL[s.kind]}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Barre d'action collante (flush immédiat) */}
      {pendingCount > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-30 p-3 bg-gradient-to-t from-zinc-950/90 to-transparent md:max-w-5xl md:mx-auto">
          <div className="rounded-xl bg-emerald-600 text-white py-3 text-center font-medium active:scale-[.99]"
               onClick={flushPending}>
            Enregistrer maintenant ({pendingCount} modif{pendingCount>1?'s':''})
          </div>
        </div>
      )}

      {/* Bottom Sheet mobile : liste des créneaux du jour */}
      {openDay && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button className="absolute inset-0 bg-black/40" onClick={()=>setOpenDay(null)} />
          <div className="absolute inset-x-0 bottom-0 rounded-t-2xl bg-white border-t border-zinc-200 p-3 pb-[calc(env(safe-area-inset-bottom)+16px)]">
            <div className="flex items-center justify-between mb-2">
              <div className="font-medium">{openDay}</div>
              <button onClick={()=>setOpenDay(null)} className="px-2 py-1 rounded bg-zinc-100">Fermer</button>
            </div>
            <div className="space-y-2">
              {(slotsByDate[openDay] || []).map(s => {
                const checked = !!availability[s.id];
                const mKey = yyyymm(new Date(openDay + 'T00:00:00'));
                const locked = !!monthStatus[mKey]?.locked;

                return (
                  <label key={s.id} className={`flex items-center justify-between px-3 py-2 rounded-lg border ${checked ? 'bg-emerald-50 border-emerald-200' : 'bg-white border-zinc-200'}`}>
                    <span className="text-zinc-800">{KIND_LABEL[s.kind]}</span>
                    <input
                      type="checkbox"
                      className="h-5 w-5"
                      checked={checked}
                      disabled={locked}
                      onChange={(e)=>toggleLocal(s.id, e.target.checked)}
                    />
                  </label>
                );
              })}
              {(slotsByDate[openDay] || []).length === 0 && (
                <div className="text-sm text-zinc-500">Aucun créneau pour ce jour.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
