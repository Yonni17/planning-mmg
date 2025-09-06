// app/components/mobile/AvailabilityCalendar.tsx
'use client';
import { useMemo, useState } from 'react';

type SlotKind = 'WEEKDAY_20_00'|'SAT_12_18'|'SAT_18_00'|'SUN_08_14'|'SUN_14_20'|'SUN_20_24';
type DaySlots = Record<SlotKind, boolean>;
type MonthMap = Record<string /* YYYY-MM-DD */, DaySlots>;

const KINDS: {id: SlotKind; label: string}[] = [
  { id:'WEEKDAY_20_00', label:'20h–00h (Lun–Ven)'},
  { id:'SAT_12_18',     label:'Sam 12–18'},
  { id:'SAT_18_00',     label:'Sam 18–00'},
  { id:'SUN_08_14',     label:'Dim 08–14'},
  { id:'SUN_14_20',     label:'Dim 14–20'},
  { id:'SUN_20_24',     label:'Dim 20–00'},
];

function ymd(d: Date){ return d.toISOString().slice(0,10); }
function startOfMonth(d: Date){ return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); }
function addDays(d: Date, n: number){ return new Date(d.getTime() + n*86400000); }

export default function AvailabilityCalendar({
  value,
  onChange,
}: {
  value: MonthMap;                 // état des dispos pour le mois
  onChange: (next: MonthMap) => void;
}) {
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
  const [selected, setSelected] = useState<string|null>(null); // YYYY-MM-DD
  const [dirty, setDirty] = useState(false);

  // construit la grille (du lundi au dimanche si tu veux : ici dimanche=0)
  const days = useMemo(() => {
    const first = startOfMonth(cursor);
    const offset = first.getUTCDay(); // 0..6 (dim..sam)
    const start = addDays(first, -offset);
    return Array.from({length: 42}, (_,i) => addDays(start, i)); // 6 semaines
  }, [cursor]);

  const toggle = (day: string, k: SlotKind) => {
    const cur = value[day] ?? KINDS.reduce((acc,kk)=>({ ...acc, [kk.id]: false }), {} as DaySlots);
    const next = { ...value, [day]: { ...cur, [k]: !cur[k] } };
    setDirty(true);
    onChange(next);
  };

  return (
    <div className="pb-24"> {/* laisse de la place à la barre de validation */}
      {/* header mois */}
      <div className="sticky top-0 z-10 bg-zinc-900/80 backdrop-blur border-b border-zinc-800 px-3 py-2 flex items-center gap-2">
        <button className="px-2 py-1 rounded bg-zinc-800" onClick={()=>setCursor(addDays(cursor, -31))}>‹</button>
        <div className="font-semibold text-white grow text-center">
          {cursor.toLocaleString('fr-FR', { month:'long', year:'numeric' })}
        </div>
        <button className="px-2 py-1 rounded bg-zinc-800" onClick={()=>setCursor(addDays(cursor, 31))}>›</button>
      </div>

      {/* grille */}
      <div className="grid grid-cols-7 gap-px bg-zinc-800">
        {['D','L','M','M','J','V','S'].map(d=>(
          <div key={d} className="text-center text-xs text-zinc-400 py-1 bg-zinc-900">{d}</div>
        ))}
        {days.map((d) => {
          const key = ymd(d);
          const isCurMonth = d.getUTCMonth() === cursor.getUTCMonth();
          const daySlots = value[key];
          const hasAny = !!daySlots && Object.values(daySlots).some(Boolean);
          return (
            <button
              key={key}
              onClick={()=>setSelected(key)}
              className={`h-14 p-1 text-left bg-zinc-900 ${isCurMonth ? 'text-zinc-100' : 'text-zinc-500'}`
              }>
              <div className="text-xs">{d.getUTCDate()}</div>
              {hasAny && <div className="mt-1 h-1.5 w-6 rounded bg-emerald-500" />}
            </button>
          );
        })}
      </div>

      {/* bottom sheet simple */}
      {selected && (
        <div className="fixed inset-x-0 bottom-0 z-20 rounded-t-2xl bg-zinc-900 border-t border-zinc-800 p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="font-medium text-white">{selected}</div>
            <button onClick={()=>setSelected(null)} className="px-2 py-1 rounded bg-zinc-800">Fermer</button>
          </div>
          <div className="space-y-2">
            {KINDS.map(k=>(
              <label key={k.id} className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={!!value[selected!]?.[k.id]}
                  onChange={()=>toggle(selected!, k.id)}
                  className="h-5 w-5"
                />
                <span className="text-zinc-200">{k.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* barre d’action */}
      {dirty && (
        <div className="fixed inset-x-0 bottom-0 z-30 p-3 bg-gradient-to-t from-zinc-950 to-transparent">
          <div className="rounded-xl bg-emerald-600 text-white py-3 text-center font-medium active:scale-[.99]"
            onClick={()=>setDirty(false)}>
            Enregistrer
          </div>
        </div>
      )}
    </div>
  );
}
