// app/admin/agenda/page.tsx
'use client';

import { useEffect, useMemo, useState, ReactNode } from 'react';
import { supabase } from '@/lib/supabase';
import { useRouter } from 'next/navigation';

type Slot = {
  id: string;
  period_id: string;
  date: string; // YYYY-MM-DD
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

type Profile = {
  user_id: string;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  email: string | null;
};

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

// ✅ limite d’édition
const YONNI_ID = '9d5c4afd-e92b-4063-a244-298915092c68';
const YONNI_EMAIL = 'yonnibibas@gmail.com';

export default function AgendaPage() {
  const router = useRouter();

  const [periods, setPeriods] = useState<Period[]>([]);
  const [periodId, setPeriodId] = useState<string>('');
  const [slots, setSlots] = useState<Slot[]>([]);
  const [assignBySlot, setAssignBySlot] = useState<Record<string, string>>({}); // slot_id -> user_id
  const [allProfiles, setAllProfiles] = useState<Profile[]>([]);
  const [nameMap, setNameMap] = useState<Record<string, string>>({}); // user_id -> "Prénom Nom"
  const [availBySlot, setAvailBySlot] = useState<Record<string, string[]>>({}); // slot_id -> [user_id...]
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [viewMonth, setViewMonth] = useState<Date | null>(null);

  // Auth
  const [meId, setMeId] = useState<string | null>(null);
  const [meEmail, setMeEmail] = useState<string | null>(null);

  // UI édition : slot actuellement ouvert en <select>
  const [editingSlotId, setEditingSlotId] = useState<string | null>(null);

  // Seul Yonni peut éditer
  const isEditor = useMemo(
    () => (meId === YONNI_ID) || (meEmail?.toLowerCase() === YONNI_EMAIL.toLowerCase()),
    [meId, meEmail]
  );

  useEffect(() => {
    (async () => {
      setLoading(true);

      // Auth minimal
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.replace('/login'); return; }
      setMeId(user.id);
      setMeEmail((user.email ?? user.user_metadata?.email ?? null) as string | null);

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

      // Profils (tous) pour liste « forcer l’attribution »
      const { data: profs, error: profErr } = await supabase
        .from('profiles')
        .select('user_id, first_name, last_name, full_name, email');
      if (profErr) {
        setMsg(`Erreur profils: ${profErr.message}`);
      } else {
        setAllProfiles((profs || []) as Profile[]);
      }

      setLoading(false);
    })();
  }, [router]);

  // Construit un nameMap complet (assignés + tous profs)
  useEffect(() => {
    const nmap: Record<string, string> = {};
    for (const p of allProfiles) {
      const full =
        (p.full_name?.trim()) ||
        `${(p.first_name ?? '').trim()} ${(p.last_name ?? '').trim()}`.trim() ||
        p.user_id;
      nmap[p.user_id] = full;
    }
    // garde les noms existants au besoin
    for (const [uid, n] of Object.entries(nameMap)) {
      if (!nmap[uid]) nmap[uid] = n;
    }
    setNameMap(nmap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allProfiles]);

  async function loadData(pid: string) {
    setMsg(null);
    setEditingSlotId(null);

    // Slots
    const { data: slotsData, error: sErr } = await supabase
      .from('slots')
      .select('id, period_id, date, start_ts, end_ts, kind')
      .eq('period_id', pid)
      .order('start_ts', { ascending: true });
    if (sErr) { setMsg(`Erreur slots: ${sErr.message}`); return; }
    const ss = (slotsData || []) as Slot[];
    setSlots(ss);

    if (!viewMonth && (ss.length > 0)) {
      const d0 = new Date(ss[0].date + 'T00:00:00');
      setViewMonth(new Date(d0.getFullYear(), d0.getMonth(), 1));
    }

    // Assignations
    const { data: assigns, error: aErr } = await supabase
      .from('assignments')
      .select('slot_id, user_id')
      .eq('period_id', pid);
    if (aErr) { setMsg(`Erreur assignations: ${aErr.message}`); return; }

    const map: Record<string, string> = {};
    for (const row of assigns || []) {
      if (row.slot_id && row.user_id) {
        map[row.slot_id as string] = row.user_id as string;
      }
    }
    setAssignBySlot(map);

    // Dispos (availability)
    if (ss.length > 0) {
      const slotIds = ss.map(s => s.id);
      const availMap: Record<string, string[]> = {};
      // Chunk pour éviter 1000+ IN
      const CHUNK = 200;
      for (let i = 0; i < slotIds.length; i += CHUNK) {
        const chunk = slotIds.slice(i, i + CHUNK);
        const { data: rows, error: avErr } = await supabase
          .from('availability')
          .select('slot_id, user_id, available')
          .in('slot_id', chunk);
        if (avErr) { setMsg(`Erreur disponibilités: ${avErr.message}`); return; }
        for (const r of (rows || []) as { slot_id: string; user_id: string; available: boolean }[]) {
          if (!r.available) continue;
          (availMap[r.slot_id] ||= []).push(r.user_id);
        }
      }
      setAvailBySlot(availMap);
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

  // Helpers options de sélection (dispos d'abord, puis tous)
  const optionsForSlot = (slotId: string) => {
    const av = new Set(availBySlot[slotId] || []);
    // disponibles
    const first = allProfiles
      .filter(p => av.has(p.user_id))
      .sort((a, b) => (nameMap[a.user_id] || a.user_id).localeCompare(nameMap[b.user_id] || b.user_id, 'fr'));
    // autres
    const rest = allProfiles
      .filter(p => !av.has(p.user_id))
      .sort((a, b) => (nameMap[a.user_id] || a.user_id).localeCompare(nameMap[b.user_id] || b.user_id, 'fr'));
    return { first, rest };
  };

  // Upsert assignment (sécurité : réservé à Yonni)
  async function assignSlot(slot: Slot, userId: string | null) {
    if (!isEditor) return;
    try {
      const payload: any = {
        slot_id: slot.id,
        period_id: slot.period_id,
        decided_by: meId ?? null,
        user_id: userId,             // peut être null pour vider
        // state: DEFAULT 'draft'
        // score: DEFAULT 0
      };
      const { error } = await supabase
        .from('assignments')
        .upsert(payload, { onConflict: 'slot_id' });
      if (error) throw error;

      // MAJ locale
      setAssignBySlot(prev => {
        const clone = { ...prev };
        if (userId) clone[slot.id] = userId;
        else delete clone[slot.id];
        return clone;
      });
      setEditingSlotId(null);
    } catch (e: any) {
      setMsg(`Échec d'attribution: ${e?.message ?? e}`);
    }
  }

  // rendu d'une cellule de jour (compact = mobile)
  const renderDayCell = (d: Date | null, key: React.Key, compact = false): ReactNode => {
    if (!d) {
      return (
        <div
          key={key}
          className={`rounded-xl border border-dashed border-gray-200 bg-gray-50 ${compact ? 'h-28 sm:h-32' : 'h-36'}`}
        />
      );
    }

    const ymd = ymdLocal(d);
    const daySlots = slotsByDate[ymd] || [];
    const dayNum = d.getDate();

    const todayYmd = ymdLocal(new Date());
    const isToday = ymd === todayYmd;

    const shellCls = `rounded-2xl border border-gray-200 overflow-hidden bg-white shadow-sm ${
      compact ? 'h-28 sm:h-32' : 'h-36'
    } ${isToday ? 'ring-1 ring-emerald-300' : ''}`;

    return (
      <div key={key} className={shellCls}>
        {/* header jour */}
        <div className="px-2 pt-2 pb-1 text-sm font-medium text-gray-700 flex items-center justify-between">
          <span>{dayNum}</span>
          <span className="text-xs text-gray-400">{d.toLocaleDateString('fr-FR', { weekday: 'short' })}</span>
        </div>

        {/* contenu jour */}
        {daySlots.length === 0 ? (
          <div className="h-[calc(100%-2rem)] flex items-center justify-center text-[11px] text-gray-400">
            Aucun créneau
          </div>
        ) : daySlots.length === 1 ? (
          // === Cas 1 créneau : horaire centré haut + nom sur toute la hauteur ===
          (() => {
            const s = daySlots[0];
            const uid = assignBySlot[s.id];
            const name = uid ? (nameMap[uid] ?? uid) : null;
            const isMine = !!(meId && uid && meId === uid);
            const isEditing = editingSlotId === s.id && isEditor;

            return (
              <div
                className={`h-[calc(100%-2rem)] px-3 py-2 flex flex-col gap-2 ${
                  isMine ? 'bg-amber-100' : 'bg-white'
                } ${isEditor ? 'cursor-pointer hover:bg-gray-50' : ''}`}
                onClick={() => { if (isEditor) setEditingSlotId(prev => (prev === s.id ? null : s.id)); }}
                title={labelFor(s.kind)}
              >
                <div className={`text-xs text-center tracking-wide ${isMine ? 'text-gray-800 font-semibold' : 'text-gray-600'}`}>
                  {labelFor(s.kind)}
                </div>

                {!isEditing ? (
                  <div
                    className={[
                      "flex-1 flex items-center justify-center text-center leading-snug whitespace-normal break-words",
                      isMine ? "text-base md:text-lg font-bold text-black" : "text-base md:text-lg font-semibold text-emerald-700"
                    ].join(' ')}
                    style={{ wordBreak: 'break-word' }}
                  >
                    {name || <span className="italic text-gray-400">—</span>}
                  </div>
                ) : (
                  <div
                    className="mt-1"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <SlotEditor
                      slot={s}
                      currentUserId={uid ?? null}
                      nameMap={nameMap}
                      options={optionsForSlot(s.id)}
                      onCancel={() => setEditingSlotId(null)}
                      onSelect={async (newUserId) => { await assignSlot(s, newUserId); }}
                    />
                  </div>
                )}
              </div>
            );
          })()
        ) : (
          // === Cas plusieurs créneaux : petites cartes, wrap + scroll ===
          <div className="h-[calc(100%-2rem)] px-2 pb-2 flex flex-col gap-1 overflow-y-auto">
            {daySlots.map((s) => {
              const uid = assignBySlot[s.id];
              const name = uid ? (nameMap[uid] ?? uid) : null;
              const isMine = !!(meId && uid && meId === uid);
              const isEditing = editingSlotId === s.id && isEditor;

              return (
                <div
                  key={s.id}
                  className={[
                    "rounded-md border px-2 py-1 text-[11px] md:text-xs",
                    isMine ? "bg-amber-100 border-amber-300" : "bg-white border-gray-200",
                    isEditor ? "cursor-pointer hover:bg-gray-50" : ""
                  ].join(" ")}
                  title={labelFor(s.kind)}
                  onClick={() => { if (isEditor) setEditingSlotId(prev => prev === s.id ? null : s.id); }}
                >
                  <div className={`leading-snug ${isMine ? 'text-gray-800 font-medium' : 'text-gray-700'}`}>
                    {labelFor(s.kind)}
                  </div>

                  {!isEditing ? (
                    name ? (
                      <div
                        className={[
                          "mt-0.5 leading-snug whitespace-normal break-words",
                          isMine ? "font-bold text-black" : "font-semibold text-emerald-700"
                        ].join(" ")}
                        style={{ wordBreak: 'break-word' }}
                      >
                        {name}{isMine ? ' (vous)' : ''}
                      </div>
                    ) : (
                      <div className="mt-0.5 italic text-gray-400">—</div>
                    )
                  ) : (
                    <div
                      className="mt-1"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <SlotEditor
                        slot={s}
                        currentUserId={uid ?? null}
                        nameMap={nameMap}
                        options={optionsForSlot(s.id)}
                        onCancel={() => setEditingSlotId(null)}
                        onSelect={async (newUserId) => { await assignSlot(s, newUserId); }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
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

        {isEditor && (
          <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-1 rounded">
            Mode édition actif (réservé à Yonni)
          </div>
        )}
      </div>

      {msg && (
        <div className={`p-3 rounded border ${msg?.startsWith('Erreur') || msg?.startsWith('Échec') ? 'bg-red-50 border-red-200 text-red-900' : 'bg-gray-50 border-gray-200 text-gray-800'}`}>
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

/** Petit composant inline pour éditer un slot */
function SlotEditor(props: {
  slot: Slot;
  currentUserId: string | null;
  nameMap: Record<string, string>;
  options: { first: Profile[]; rest: Profile[] };
  onCancel: () => void;
  onSelect: (userId: string | null) => Promise<void>;
}) {
  const { currentUserId, nameMap, options, onCancel, onSelect } = props;
  const [value, setValue] = useState<string>(currentUserId ?? '');
  const [saving, setSaving] = useState(false);

  async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const v = e.target.value;
    setValue(v);
    setSaving(true);
    try {
      await onSelect(v === '' ? null : v);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="flex items-center gap-2"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <select
        value={value}
        onChange={handleChange}
        className="border rounded px-2 py-1 text-xs bg-white text-gray-900"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <option value="">— Aucun / vider —</option>
        {options.first.length > 0 && (
          <optgroup label="Disponibles">
            {options.first.map(p => (
              <option key={p.user_id} value={p.user_id}>
                {nameMap[p.user_id] || p.user_id}
              </option>
            ))}
          </optgroup>
        )}
        {options.rest.length > 0 && (
          <optgroup label="Autres (forcer)">
            {options.rest.map(p => (
              <option key={p.user_id} value={p.user_id}>
                {nameMap[p.user_id] || p.user_id}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <button
        type="button"
        className="text-[11px] px-2 py-1 rounded border hover:bg-gray-50"
        onClick={(e) => { e.stopPropagation(); onCancel(); }}
        disabled={saving}
      >
        Annuler
      </button>
    </div>
  );
}
