// components/AvailabilityGrid.tsx
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type SlotMap = Record<string, boolean>; // key ex: "2025-09-07 09:00"

type Props = {
  // période courante (premier jour affiché, inclus)
  startDateISO: string; // "2025-09-01"
  days: number;         // ex: 7
  hours: number[];      // ex: [8,9,10,...,18]
};

// util
const pad = (n: number) => String(n).padStart(2, '0');
function keyFor(dateISO: string, hour: number) {
  return `${dateISO} ${pad(hour)}:00`;
}
function addDays(baseISO: string, d: number) {
  const dt = new Date(baseISO + 'T00:00:00');
  dt.setDate(dt.getDate() + d);
  return dt.toISOString().slice(0, 10);
}
function isDesktop() {
  // On *bloque* les UI mobiles sur desktop
  return window.matchMedia && window.matchMedia('(pointer: fine)').matches;
}

export default function AvailabilityGrid({ startDateISO, days, hours }: Props) {
  const [slots, setSlots] = useState<SlotMap>({});
  const [loading, setLoading] = useState(true);
  const debounceRef = useRef<number | null>(null);
  const pendingChanges = useRef<SlotMap>({}); // accumulation pour save batch

  const dates = useMemo(() => {
    return Array.from({ length: days }, (_, i) => addDays(startDateISO, i));
  }, [startDateISO, days]);

  // init: charger l’état côté API (lecture simple)
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        const q = new URLSearchParams({
          start: startDateISO,
          days: String(days),
        }).toString();
        const res = await fetch(`/api/availability?${q}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          cache: 'no-store',
        });
        const json = await res.json();
        if (res.ok && json?.slots) {
          setSlots(json.slots as SlotMap);
        } else {
          // pas de bandeau/erreur visible — silencieux
        }
      } catch {
        // silencieux
      } finally {
        setLoading(false);
      }
    })();
  }, [startDateISO, days]);

  // enregistrement (debounce, silencieux)
  const scheduleSave = () => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(async () => {
      const changes = pendingChanges.current;
      pendingChanges.current = {};
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        await fetch('/api/availability', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ changes }), // { "2025-09-07 09:00": true/false, ... }
        });
        // silencieux : rien à afficher si OK
      } catch {
        // En cas d’erreur, on annule localement les changements qui étaient dans "changes"
        setSlots((prev) => {
          const copy = { ...prev };
          for (const k of Object.keys(changes)) {
            copy[k] = !changes[k]; // rollback
          }
          return copy;
        });
      }
    }, 500);
  };

  const onToggle = (dateISO: string, hour: number) => {
    // pas de menu mobile sur PC : un simple clic toggle
    if (!isDesktop()) {
      // Sur mobile, tu peux brancher ici un menu si tu en veux un jour.
      // Mais pour ta demande actuelle : on garde le même comportement (toggle simple).
    }
    const k = keyFor(dateISO, hour);
    setSlots((prev) => {
      const next = { ...prev, [k]: !prev[k] };
      // accumulate change
      pendingChanges.current[k] = !!next[k];
      return next;
    });
    scheduleSave();
  };

  return (
    <div className="w-full">
      <div className="text-sm text-zinc-400 mb-2">
        {loading ? 'Chargement…' : 'Cliquez pour activer/désactiver vos créneaux'}
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-700">
        <table className="min-w-full text-sm">
          <thead className="bg-zinc-900/60 text-zinc-300">
            <tr>
              <th className="px-3 py-2 text-left">Heure</th>
              {dates.map(d => (
                <th key={d} className="px-3 py-2 text-left">
                  {new Date(d + 'T00:00:00').toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit' })}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800 bg-zinc-900/30 text-zinc-200">
            {hours.map(h => (
              <tr key={h}>
                <td className="px-3 py-2 text-zinc-400">{`${pad(h)}:00`}</td>
                {dates.map(d => {
                  const k = keyFor(d, h);
                  const active = !!slots[k];
                  return (
                    <td key={k} className="px-1 py-1">
                      <button
                        onClick={() => onToggle(d, h)}
                        className={[
                          'w-full h-9 rounded-md border text-xs',
                          active
                            ? 'border-emerald-700 bg-emerald-800/60 text-emerald-100'
                            : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800'
                        ].join(' ')}
                        aria-pressed={active}
                      >
                        {active ? 'Disponible' : '—'}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Aucun bandeau ni toast de “sauvegardé” ici */}
    </div>
  );
}
