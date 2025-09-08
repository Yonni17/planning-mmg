// app/calendrier/page.tsx
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

type Period = { id: string; label: string; open_at: string };

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

function fmtDateInParis(d: Date) {
  return d.toLocaleString('fr-FR', {
    timeZone: 'Europe/Paris',
    dateStyle: 'full',
    timeStyle: 'short',
  });
}

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

  // Countdown (deadline = open_at - 21 jours)
  const [deadline, setDeadline] = useState<Date | null>(null);
  const [nowTick, setNowTick] = useState<number>(Date.now()); // tick chaque minute

  // autosave silencieux (debounce)
  const debounceRef = useRef<number | null>(null);
  const pendingIdsRef = useRef<Set<string>>(new Set());

  // État d’ouverture du bloc d’instructions (ouvert par défaut en ≥ md)
  const [instOpen, setInstOpen] = useState<boolean>(true);

  // --------- INIT ---------
  useEffect(() => {
    (async () => {
      setLoading(true);

      // 1) Auth
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.replace('/login'); return; }
      setUserId(user.id);

      // 2) Profil existant sinon créer minimal
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

      // 3) Périodes (on récupère aussi open_at pour le compte à rebours)
      const { data: periodsData } = await supabase
        .from('periods')
        .select('id,label,open_at')
        .order('open_at', { ascending: false });

      const list = (periodsData || []) as Period[];
      setPeriods(list);

      const defId = list[0]?.id || '';
      setPeriodId(defId);

      if (defId) {
        await Promise.all([
          loadSlotsAndAvail(defId, user.id),
          loadMonthStatus(defId, user.id),
        ]);
        // calcule deadline: open_at - 21 jours
        const p = list.find(p => p.id === defId);
        if (p?.open_at) {
          const open = new Date(p.open_at);
          const dl = new Date(open.getTime() - 21 * 24 * 60 * 60 * 1000);
          setDeadline(dl);
        }
      }

      setLoading(false);
    })();
  }, [router]);

  // défaut du bloc d’instructions : ouvert en ≥ md, replié en < md
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const mq = window.matchMedia('(min-width: 768px)');
      setInstOpen(mq.matches);
    }
  }, []);

  // --------- TICK du compte à rebours (toutes les minutes) ---------
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 60 * 1000);
    return () => clearInterval(t);
  }, []);

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

    const payload = ids.map(slot_id => ({
      user_id: userId,
      slot_id,
      available: !!availability[slot_id],
    }));

    try {
      // IMPORTANT: expliciter onConflict (PK composite)
      const { error } = await supabase.from('availability').upsert(payload, { onConflict: 'user_id,slot_id' });
      if (error) throw error;
      pendingIdsRef.current = new Set();
    } catch {
      setAvailability(prev => {
        const copy = { ...prev };
        for (const slot_id of ids) {
          copy[slot_id] = !copy[slot_id];
        }
        return copy;
      });
      pendingIdsRef.current = new Set();
    }
  };

  const scheduleSave = () => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(flushSave, 500);
  };

  // Flush en sortie de page / onglet caché pour ne pas perdre de clics
  useEffect(() => {
    const handleBeforeUnload = () => { flushSave(); };
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') flushSave();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // --------- HELPERS ---------
  async function ensureMonthRow(pid: string, uid: string, mKey: string) {
    // Crée la ligne doctor_period_months si absente (non verrouillée)
    const { error } = await supabase
      .from('doctor_period_months')
      .upsert(
        { user_id: uid, period_id: pid, month: mKey, locked: false, opted_out: false },
        { onConflict: 'user_id,period_id,month' }
      );
    if (error) throw error;
  }

  // --------- ACTIONS ---------
  const toggleLocal = async (slotId: string, locked: boolean) => {
    if (locked || !userId || !periodId) return;

    // 1) UI optimiste
    setAvailability(prev => ({ ...prev, [slotId]: !prev[slotId] }));

    // 2) Déduire le mois (YYYY-MM) du slot pour assurer la ligne parent
    const s = slots.find(x => x.id === slotId);
    const mKey = s ? yyyymm(new Date(s.date + 'T00:00:00')) : currentMonthKey;

    try {
      if (mKey) await ensureMonthRow(periodId, userId, mKey);

      // 3) Écrire immédiatement CE slot (persistance inter-pages)
      const nextVal = !availability[slotId];
      const { error } = await supabase
        .from('availability')
        .upsert(
          { user_id: userId, slot_id: slotId, available: nextVal },
          { onConflict: 'user_id,slot_id' }
        );
      if (error) throw error;

      // 4) On conserve le batch pour d’éventuels multi-clics rapides
      pendingIdsRef.current.add(slotId);
      scheduleSave();
    } catch (e) {
      // rollback UI si l’écriture échoue
      setAvailability(prev => ({ ...prev, [slotId]: !!prev[slotId] }));
      console.error('availability upsert error', e);
    }
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

  // --------- COUNTDOWN helpers ---------
  const countdown = useMemo(() => {
    if (!deadline) return null;
    // force recalcul avec nowTick
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _ = nowTick;
    const diff = deadline.getTime() - Date.now();
    const past = diff <= 0;
    const abs = Math.abs(diff);
    const d = Math.floor(abs / (1000 * 60 * 60 * 24));
    const h = Math.floor((abs / (1000 * 60 * 60)) % 24);
    const m = Math.floor((abs / (1000 * 60)) % 60);
    return { past, d, h, m };
  }, [deadline, nowTick]);

  // --------- RENDER ---------
  if (loading) return <p className="text-zinc-300">Chargement…</p>;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-zinc-100">Mes disponibilités</h1>

      {/* Sélecteurs période & mois */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* Sélecteur période */}
        <select
          className="border rounded p-2 text-black
                     bg-white dark:bg-zinc-800
                     border-zinc-300 dark:border-zinc-600
                     shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
          value={periodId}
          onChange={async (e) => {
            const v = e.target.value;
            setPeriodId(v);
            if (userId) {
              await Promise.all([
                loadSlotsAndAvail(v, userId),
                loadMonthStatus(v, userId),
              ]);
              const p = periods.find(p => p.id === v);
              if (p?.open_at) {
                const open = new Date(p.open_at);
                setDeadline(new Date(open.getTime() - 21 * 24 * 60 * 60 * 1000));
              } else {
                setDeadline(null);
              }
            }
          }}
        >
          {periods.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>

        {/* Onglets Mois */}
        <div className="flex flex-wrap gap-2">
          {monthsInPeriod.map(m => {
            const st = monthStatus[m.key];
            const isActive = currentMonthKey === m.key;

            // Couleurs moins pâles (vert validé, rouge à valider)
            const greenTab =
              'bg-green-200 text-green-900 border border-green-400 ' +
              'dark:bg-emerald-700 dark:text-white dark:border-emerald-500';
            const redTab =
              'bg-red-200 text-red-900 border border-red-400 ' +
              'dark:bg-red-700 dark:text-white dark:border-red-500';

            const base = st?.locked ? greenTab : redTab;
            const notActive = `${base} hover:opacity-90 transition`;
            const active =
              'bg-white text-black border-2 border-emerald-400 shadow-sm ' +
              'dark:bg-zinc-900 dark:text-white dark:border-emerald-500';

            return (
              <button
                key={m.key}
                className={`px-3 py-1.5 rounded ${isActive ? active : notActive}`}
                onClick={() => setViewMonth(m.date)}
                title={st?.locked ? 'Validé' : 'À valider'}
              >
                {m.label}
              </button>
            );
          })}
          {monthsInPeriod.length === 0 && (
            <div className="text-sm text-zinc-400">
              Aucun créneau pour l’instant.
            </div>
          )}
        </div>

        {/* Actions mois courant : Verrouiller / Déverrouiller */}
        {!!currentMonthKey && (
          <div className="ml-auto flex items-center gap-2">
            {monthStatus[currentMonthKey]?.locked ? (
              <>
                <span className="text-sm text-green-600 dark:text-emerald-400">
                  Mois verrouillé ✅
                </span>
                <button
                  className="px-3 py-1.5 rounded border
                             border-zinc-300 hover:bg-zinc-50
                             dark:border-zinc-600 dark:hover:bg-zinc-800 dark:text-zinc-100"
                  onClick={() => unlockMonth(currentMonthKey)}
                >
                  Déverrouiller
                </button>
              </>
            ) : (
              <>
                <span className="text-sm text-red-600 dark:text-red-400">
                  Mois non verrouillé
                </span>
                <button
                  className="px-3 py-1.5 rounded border
                             border-emerald-300 text-emerald-900 bg-emerald-50 hover:bg-emerald-100
                             dark:border-emerald-500 dark:text-white dark:bg-emerald-700 dark:hover:bg-emerald-600"
                  onClick={() => validateMonth(currentMonthKey)}
                >
                  Verrouiller ce mois
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Bloc d’instructions REPLIABLE */}
      <details
        className="rounded-xl border
                   border-zinc-300 bg-zinc-50 text-zinc-800
                   dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        open={instOpen}
        onToggle={(e) => setInstOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium flex items-center justify-between">
          <span>Comment renseigner vos disponibilités ?</span>
          <span className="ml-4 text-xs text-zinc-500 dark:text-zinc-400">
            {instOpen ? 'Masquer' : 'Afficher'}
          </span>
        </summary>

        <div className="px-4 pb-4 -mt-1">
          <ol className="list-decimal pl-5 space-y-1 text-sm">
            <li>Choisissez le <strong>trimestre</strong> en haut.</li>
            <li>Cliquez sur le <strong>mois</strong> voulu pour l’afficher.</li>
            <li>Dans chaque jour, <strong>cliquez</strong> les créneaux pour les passer en vert ✅ (disponible) ou en gris (indisponible).</li>
            <li>Quand tout est ok pour le mois, cliquez sur <strong>“Verrouiller ce mois”</strong> pour signaler que c’est complet.</li>
            <li>Vous pouvez <strong>déverrouiller</strong> si vous devez corriger avant la date limite.</li>
          </ol>

          {/* Countdown intégré ici pour rester visible au besoin */}
          <div className="mt-3 text-sm">
            {deadline ? (
              <>
                <div className="font-medium">
                  Clôture des disponibilités (J-21 avant le début du trimestre) :
                  <span className="ml-1">
                    {fmtDateInParis(deadline)}
                  </span>
                </div>
                <div className="mt-1 font-semibold">
                  {countdown && !countdown.past
                    ? <>⏳ Il reste <span className="tabular-nums">{countdown.d} j {countdown.h} h {countdown.m} min</span>.</>
                    : <>⛔ La période de saisie des disponibilités est <span className="font-bold">fermée</span>.</>}
                </div>
              </>
            ) : (
              <div className="text-zinc-500">
                La date de clôture sera affichée dès qu’une période est sélectionnée.
              </div>
            )}
          </div>
        </div>
      </details>

      {/* Grille mensuelle */}
      <div className="grid grid-cols-7 gap-2">
        {['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'].map(w => (
          <div key={w} className="text-center text-xs uppercase tracking-wide text-zinc-500">{w}</div>
        ))}

        {daysOfMonth.map((d, i) => {
          if (!d) {
            return (
              <div
                key={i}
                className="h-32 rounded-xl border border-dashed
                           border-zinc-300 bg-zinc-100
                           dark:border-zinc-700 dark:bg-zinc-900"
              />
            );
          }

          const key = ymdLocal(d);
          const daySlots = slotsByDate[key] || [];
          const dayNum = d.getDate();
          const mKey = yyyymm(d);
          const locked = !!monthStatus[mKey]?.locked;

          return (
            <div
              key={i}
              className="h-32 rounded-2xl overflow-hidden shadow-sm
                         border border-zinc-300 bg-white
                         dark:border-zinc-700 dark:bg-zinc-900"
            >
              <div className="px-2 pt-2 pb-1 text-sm font-medium
                              text-zinc-700 dark:text-zinc-200
                              flex items-center justify-between">
                <span>{dayNum}</span>
                <span className="text-xs text-zinc-400">
                  {d.toLocaleDateString('fr-FR', { weekday: 'short' })}
                </span>
              </div>

              <div className="flex flex-col h-[calc(100%-2rem)]">
                {daySlots.length === 0 ? (
                  <div className="flex-1 text-xs px-2
                                  text-zinc-500 dark:text-zinc-400
                                  flex items-center justify-center">
                    Aucun créneau
                  </div>
                ) : daySlots.map((s) => {
                  const on = !!availability[s.id];
                  const onCls =
                    'bg-emerald-600 text-white hover:bg-emerald-500 ' +
                    'dark:bg-emerald-600 dark:hover:bg-emerald-500';
                  const offCls =
                    'bg-zinc-100 text-zinc-700 hover:bg-zinc-200 ' +
                    'dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700';

                  return (
                    <button
                      key={s.id}
                      type="button"
                      disabled={locked}
                      onClick={() => toggleLocal(s.id, locked)}
                      className={`flex-1 text-[11px] px-2 border-t first:border-t-0
                                  border-zinc-200 dark:border-zinc-700
                                  flex items-center justify-center
                                  ${on ? onCls : offCls}`}
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

      {/* Pas de bouton “Enregistrer” : autosave silencieux */}
    </div>
  );
}
