'use client';

import { useEffect, useMemo, useState, ReactNode } from 'react';
import { supabase } from '@/lib/supabase';
import { useRouter } from 'next/navigation';

type Slot = {
  id: string;
  period_id: string;
  date: string; // YYYY-MM-DD (locale)
  start_ts: string;
  end_ts: string;
  kind:
    | 'WEEKDAY_20_00'
    | 'SAT_12_18'
    | 'SAT_18_00'
    | 'SUN_08_14'
    | 'SUN_14_20'
    | 'SUN_20_24';
};

type Period = { id: string; label: string };

const pad = (n: number) => String(n).padStart(2, '0');
const yyyymm = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const ymdLocal = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const frMonthLabel = (d: Date) => d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });

const KIND_LABEL: Record<Slot['kind'], string> = {
  WEEKDAY_20_00: '20:00–00:00',
  SAT_12_18: '12:00–18:00',
  SAT_18_00: '18:00–00:00',
  SUN_08_14: '08:00–14:00',
  SUN_14_20: '14:00–20:00',
  SUN_20_24: '20:00–00:00',
};

const WEEKDAYS_FR = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

export default function AgendaPage() {
  const router = useRouter();

  const [periods, setPeriods] = useState<Period[]>([]);
  const [periodId, setPeriodId] = useState<string>('');
  const [slots, setSlots] = useState<Slot[]>([]);
  const [assignBySlot, setAssignBySlot] = useState<Record<string, string>>({}); // slot_id -> user_id
  const [nameMap, setNameMap] = useState<Record<string, string>>({}); // user_id -> "Prénom Nom"
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [viewMonth, setViewMonth] = useState<Date | null>(null);

  // 👤 id de l'utilisateur connecté
  const [meId, setMeId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);

      // Auth minimal
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.replace('/login'); return; }
      setMeId(user.id);

      // Périodes
      const { data: periodsData, error: pErr } = await supabase
        .from('periods')
        .select('id,label')
        .order('open_at', { ascending: false });
      if (pErr) { setMsg(`Erreur périodes: ${pErr.message}`); setLoading(false); return; }

      setPeriods(periodsData || []);
      const defId = periodsData?.[0]?.id || '';
      setPeriodId(defId);
      if (defId) await loadData(defId);
      setLoading(false);
    })();
  }, [router]);

  async function loadData(pid: string) {
    setMsg(null);

    // Slots
    const { data: slotsData, error: sErr } = await supabase
      .from('slots')
      .select('id, period_id, date, start_ts, end_ts, kind')
      .eq('period_id', pid)
      .order('start_ts', { ascending: true });
    if (sErr) { setMsg(`Erreur slots: ${sErr.message}`); return; }
    setSlots((slotsData || []) as Slot[]);

    if (!viewMonth && (slotsData?.length ?? 0) > 0) {
      const d0 = new Date(slotsData![0].date + 'T00:00:00');
      setViewMonth(new Date(d0.getFullYear(), d0.getMonth(), 1));
    }

    // Assignations
    const { data: assigns, error: aErr } = await supabase
      .from('assignments')
      .select('slot_id, user_id')
      .eq('period_id', pid);
    if (aErr) { setMsg(`Erreur assignations: ${aErr.message}`); return; }

    const map: Record<string, string> = {};
    const uids = new Set<string>();
    for (const row of assigns || []) {
      if (row.slot_id && row.user_id) {
        map[row.slot_id] = row.user_id;
        uids.add(row.user_id);
      }
    }
    setAssignBySlot(map);

    // Profils
    if (uids.size > 0) {
      const { data: profs, error: profErr } = await supabase
        .from('profiles')
        .select('user_id, first_name, last_name')
        .in('user_id', Array.from(uids));
      if (profErr) { setMsg(`Erreur profils: ${profErr.message}`); return; }

      const nmap: Record<string,string> = {};
      for (const p of profs || []) {
        const fn = (p.first_name ?? '').trim();
        const ln = (p.last_name ?? '').trim();
        const full = `${fn} ${ln}`.trim();
        nmap[p.user_id as string] = full || (p.user_id as string);
      }
      setNameMap(nmap);
    } else {
      setNameMap({});
    }
  }

  // Mois présents dans la période
  const monthsInPeriod = useMemo(() => {
    const set = new Set<string>();
    for (const s of slots) {
      const d = new Date(s.date + 'T00:00:00');
      set.add(yyyymm(d));
    }
    return Array.from(set).sort().map(m => {
      const d = new Date(m + '-01T00:00:00');
      return { key: m, date: d, label: frMonthLabel(d) };
    });
  }, [slots]);

  // Cellules du mois courant
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

  // Slots groupés par date
  const slotsByDate = useMemo(() => {
    const map: Record<string, Slot[]> = {};
    for (const s of slots) (map[s.date] ||= []).push(s);
    Object.values(map).forEach(list => list.sort((a, b) => +new Date(a.start_ts) - +new Date(b.start_ts)));
    return map;
  }, [slots]);

  const labelFor = (k: Slot['kind']) => KIND_LABEL[k];

  // rendu d'une cellule de jour (compact = mobile)
  const renderDayCell = (d: Date | null, key: React.Key, compact = false): ReactNode => {
    if (!d) {
      return (
        <div
          key={key}
          className={`rounded-xl border border-dashed border-gray-200 bg-gray-50 ${compact ? 'h-24 sm:h-28' : 'h-32'}`}
        />
      );
    }

    const ymd = ymdLocal(d);
    const daySlots = slotsByDate[ymd] || [];
    const dayNum = d.getDate();

    const todayYmd = ymdLocal(new Date());
    const isToday = ymd === todayYmd;

    return (
      <div
        key={key}
        className={`rounded-2xl border border-gray-200 overflow-hidden bg-white shadow-sm ${compact ? 'h-24 sm:h-28' : 'h-32'} ${isToday ? 'ring-1 ring-emerald-300' : ''}`}
      >
        <div className="px-2 pt-2 pb-1 text-sm font-medium text-gray-700 flex items-center justify-between">
          <span>{dayNum}</span>
          <span className="text-xs text-gray-400">
            {d.toLocaleDateString('fr-FR', { weekday: 'short' })}
          </span>
        </div>

        <div className="flex flex-col h-[calc(100%-2rem)]">
          {daySlots.length === 0 ? (
            <div className="flex-1 text-[11px] px-2 text-gray-400 flex items-center justify-center">Aucun créneau</div>
          ) : daySlots.map((s) => {
            const uid = assignBySlot[s.id];
            const name = uid ? (nameMap[uid] ?? uid) : null;
            const isMine = !!(meId && uid && meId === uid); // ✅ créneau du médecin connecté ?

            return (
              <div
                key={s.id}
                className={`flex-1 text-[11px] md:text-xs px-2 border-t first:border-t-0 flex items-center justify-between
                            ${isMine ? 'bg-amber-100 border-l-4 border-amber-500' : 'bg-white text-gray-700'}`}
                title={labelFor(s.kind)}
              >
                {/* Créneau toujours lisible sur fond ambré */}
                <span className={`truncate ${isMine ? 'text-gray-800 font-medium' : ''}`}>
                  {labelFor(s.kind)}
                </span>

                {name ? (
                  <span
                    className={`truncate max-w-[55%] md:max-w-none ${
                      isMine ? 'font-bold text-black' : 'font-semibold text-emerald-600'
                    }`}
                  >
                    {name}{isMine ? ' (vous)' : ''}
                  </span>
                ) : (
                  <span className="italic text-gray-400">—</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  if (loading) return <p>Chargement…</p>;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Agenda MMG</h1>

      {/* Sélecteurs période & mois */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600">Période</label>
          <select
            className="border rounded p-2 bg-white"
            value={periodId}
            onChange={async (e) => {
              const v = e.target.value;
              setPeriodId(v);
              await loadData(v);
            }}
          >
            {periods.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </div>

        {/* Liste des mois — défilable horizontalement sur mobile */}
        <div className="md:ml-2 overflow-x-auto">
          <div className="inline-flex gap-2 pr-1">
            {monthsInPeriod.map(m => (
              <button
                key={m.key}
                className={`px-3 py-1.5 rounded border transition-colors ${
                  viewMonth && yyyymm(viewMonth) === m.key
                    ? 'bg-black text-white border-black'
                    : 'hover:bg-gray-50 border-gray-300'
                }`}
                onClick={() => setViewMonth(m.date)}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {msg && (
        <div className={`p-3 rounded border ${msg?.startsWith('Erreur') ? 'bg-red-50 border-red-200 text-red-900' : 'bg-gray-50 border-gray-200 text-gray-800'}`}>
          {msg}
        </div>
      )}

      {/* ======= Desktop / Tablette : vraie grille 7 colonnes ======= */}
      <div className="hidden md:block">
        {/* Entête des jours de la semaine (md+) */}
        <div className="grid grid-cols-7 gap-3 mb-2">
          {WEEKDAYS_FR.map(w => (
            <div key={w} className="text-center text-xs uppercase tracking-wide text-gray-500">{w}</div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-3">
          {daysOfMonth.map((d, i) => renderDayCell(d, i, false))}
        </div>
      </div>

      {/* ======= Mobile : grille compacte 2 → 3 colonnes ======= */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 md:hidden">
        {daysOfMonth.map((d, i) => renderDayCell(d, i, true))}
      </div>
    </div>
  );
}
