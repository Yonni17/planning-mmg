'use client';

import { useEffect, useMemo, useState } from 'react';
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
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // --- sheet (menu des heures) ---
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetDate, setSheetDate] = useState<Date | null>(null);

  // -- petit buffer pour "sauvegarder maintenant" en lot (mobile)
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set());

  // --------- INIT ---------
  useEffect(() => {
    (async () => {
      setLoading(true);
      setMsg(null);

      // 1) Auth
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.replace('/login'); return; }
      setUserId(user.id);

      // 2) S’assurer qu’un profil existe (IMPORTANT pour ton FK si availability.user_id -> profiles.user_id)
      const { data: prof, error: pErr } = await supabase
        .from('profiles')
        .select('user_id, first_name, last_name, role')
        .eq('user_id', user.id)
        .maybeSingle();

      if (pErr) {
        setMsg(`Erreur profil: ${pErr.message}`);
        setLoading(false);
        return;
      }

      if (!prof) {
        // crée un profil minimal pour satisfaire le FK
        const { error: insErr } = await supabase.from('profiles').insert({
          user_id: user.id,
          first_name: null,
          last_name: null,
          role: 'doctor',
        } as any);
        if (insErr) {
          setMsg(`Erreur création profil: ${insErr.message}`);
          setLoading(false);
          return;
        }
      } else {
        // si prénom/nom manquants → on force la page Préférences
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
      if (perr) { setMsg(`Erreur périodes: ${perr.message}`); setLoading(false); return; }

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

    // toutes les dispos de l’utilisateur
    const { data: avData, error: aErr } = await supabase
      .from('availability')
      .select('slot_id, available')
      .eq('user_id', uid);
    if (aErr) { setMsg(`Erreur availability: ${aErr.message}`); return; }
    const map: Record<string, boolean> = {};
    for (const row of avData || []) map[row.slot_id as string] = !!row.available;
    setAvailability(map);
    setDirtyIds(new Set());
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

  // --------- ACTIONS ---------
  const toggleLocal = (slotId: string) => {
    const next = !availability[slotId];
    setAvailability(prev => ({ ...prev, [slotId]: next }));
    setDirtyIds(prev => new Set(prev).add(slotId));
  };

  const saveDirty = async () => {
    if (!userId || dirtyIds.size === 0) return;
    const payload = Array.from(dirtyIds).map(slot_id => ({
      user_id: userId,
      slot_id,
      available: !!availability[slot_id],
    }));

    const { error } = await supabase.from('availability').upsert(payload);
    if (error) setMsg(`❌ Sauvegarde: ${error.message}`);
    else {
      setMsg('✅ Modifications sauvegardées.');
      setDirtyIds(new Set());
    }
  };

  const validateMonth = async (mKey: string) => {
    if (!userId || !periodId) return;
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

  // --------- SHEET helpers ---------
  const openDay = (d: Date) => { setSheetDate(d); setSheetOpen(true); };
  const closeSheet = () => setSheetOpen(false);

  // --------- RENDER ---------
  if (loading) return <p>Chargement…</p>;

  const DaySheet = () => {
    if (!sheetOpen || !sheetDate) return null;
    const k = ymdLocal(sheetDate);
    const daySlots = slotsByDate[k] || [];
    const mKey = yyyymm(sheetDate);
    const locked = !!monthStatus[mKey]?.locked;

    return (
      <div className="fixed inset-0 z-50">
        {/* backdrop */}
        <div className="absolute inset-0 bg-black/60" onClick={closeSheet} />
        {/* panel */}
        <div className="absolute inset-x-0 bottom-0 rounded-t-2xl overflow-hidden shadow-xl">
          {/* Header mieux contrasté */}
          <div className="flex items-center justify-between px-4 py-3 bg-zinc-900 text-zinc-100">
            <div className="text-sm font-medium">
              {sheetDate.toLocaleDateString('fr-FR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}
            </div>
            <button onClick={closeSheet} className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-100 text-sm">
              Fermer
            </button>
          </div>

          <div className="bg-zinc-950 p-3 space-y-2">
            {daySlots.length === 0 ? (
              <div className="text-sm text-zinc-400 py-6 text-center">Aucun créneau ce jour.</div>
            ) : daySlots.map(s => {
              const on = !!availability[s.id];
              const btnCls = locked
                ? (on ? 'bg-emerald-700 text-white cursor-not-allowed' : 'bg-zinc-800 text-zinc-400 cursor-not-allowed')
                : (on ? 'bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-100 hover:bg-zinc-700');
              return (
                <button
                  key={s.id}
                  disabled={locked}
                  onClick={() => toggleLocal(s.id)}
                  className={`w-full text-left px-4 py-3 rounded-lg ${btnCls}`}
                  title={KIND_LABEL[s.kind]}
                >
                  {KIND_LABEL[s.kind]}
                </button>
              );
            })}

            {/* CTA sauvegarde */}
            <div className="pt-2">
              <button
                onClick={saveDirty}
                disabled={dirtyIds.size === 0}
                className="w-full px-4 py-3 rounded-lg bg-emerald-600 text-white disabled:opacity-60"
              >
                Enregistrer maintenant {dirtyIds.size > 0 ? `(${dirtyIds.size} modifs)` : ''}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

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

          // 👉 Toute la tuile devient cliquable pour ouvrir le menu des heures
          return (
            <button
              key={i}
              type="button"
              onClick={() => openDay(d)}
              className="h-32 rounded-2xl border border-gray-200 overflow-hidden bg-white shadow-sm text-left focus:outline-none focus:ring-2 focus:ring-emerald-400"
            >
              <div className="px-2 pt-2 pb-1 text-sm font-medium text-gray-700 flex items-center justify-between">
                <span>{dayNum}</span>
                <span className="text-xs text-gray-400">
                  {d.toLocaleDateString('fr-FR', { weekday: 'short' })}
                </span>
              </div>

              <div className="flex flex-col h-[calc(100%-2rem)] pointer-events-none">
                {daySlots.length === 0 ? (
                  <div className="flex-1 text-xs px-2 text-gray-400 flex items-center justify-center">Aucun créneau</div>
                ) : daySlots.map((s) => {
                  const on = !!availability[s.id];
                  const onCls  = locked ? 'bg-green-600 text-white' : 'bg-green-500 text-white';
                  const offCls = 'bg-white text-gray-500';
                  const cellClass  = on ? onCls : offCls;
                  return (
                    <div
                      key={s.id}
                      className={`flex-1 text-[11px] px-2 border-t first:border-t-0 ${cellClass} flex items-center justify-center`}
                      title={KIND_LABEL[s.kind]}
                    >
                      {KIND_LABEL[s.kind]}
                    </div>
                  );
                })}
              </div>
            </button>
          );
        })}
      </div>

      {/* Bouton global sauvegarde (utile desktop aussi) */}
      <div className="sticky bottom-3">
        <button
          onClick={saveDirty}
          disabled={dirtyIds.size === 0}
          className="w-full px-4 py-3 rounded-xl bg-emerald-600 text-white shadow disabled:opacity-60"
        >
          Enregistrer maintenant {dirtyIds.size > 0 ? `(${dirtyIds.size} modifs)` : ''}
        </button>
      </div>

      {/* Drawer mobile */}
      <DaySheet />
    </div>
  );
}
