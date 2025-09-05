// app/api/admin/generate-slots/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// IMPORTANT : service role côté serveur uniquement
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

// --- Helpers dates (on manipule des YYYY-MM-DD "locaux" sans timezone) ---
const DAY_MS = 24 * 60 * 60 * 1000;

function pad2(n: number) {
  return n < 10 ? `0${n}` : `${n}`;
}
function addDaysStr(yyyy_mm_dd: string, days: number): string {
  const d = new Date(`${yyyy_mm_dd}T12:00:00Z`); // midi UTC pour éviter les surprises de fuseau
  const d2 = new Date(d.getTime() + days * DAY_MS);
  return d2.toISOString().slice(0, 10);
}
function* eachDateStr(start: string, end: string) {
  let cur = new Date(`${start}T12:00:00Z`);
  const stop = new Date(`${end}T12:00:00Z`);
  while (cur.getTime() <= stop.getTime()) {
    yield cur.toISOString().slice(0, 10);
    cur = new Date(cur.getTime() + DAY_MS);
  }
}
function weekdayFromYMD(yyyy_mm_dd: string): number {
  // 0 = dimanche ... 6 = samedi
  const d = new Date(`${yyyy_mm_dd}T12:00:00Z`);
  return d.getUTCDay();
}

type Payload = {
  label: string;
  startDate: string;   // YYYY-MM-DD
  endDate: string;     // YYYY-MM-DD
  openAt: string;      // YYYY-MM-DDTHH:mm
  closeAt?: string;    // optionnel pour l'avenir
  generateAt?: string; // optionnel pour l'avenir
  timezone?: string;   // ex: Europe/Paris (non utilisé ici car on stocke en local-naïf)
  holidays?: string[]; // YYYY-MM-DD
  autoHolidays?: boolean;
};

type SlotRow = {
  period_id: string;
  date: string;       // YYYY-MM-DD (local)
  start_ts: string;   // 'YYYY-MM-DD HH:MM:SS' (timestamp SANS fuseau)
  end_ts: string;     // idem
  kind: string;       // enum texte
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<Payload>;
    // --- Validation minimale ---
    if (!body.label || !body.startDate || !body.endDate || !body.openAt) {
      return NextResponse.json(
        { ok: false, error: 'Champs requis manquants (label, startDate, endDate, openAt).' },
        { status: 400 }
      );
    }

    // Holidays (auto + manuels)
    const years = new Set<number>();
    const yStart = Number(body.startDate.slice(0, 4));
    const yEnd = Number(body.endDate.slice(0, 4));
    for (let y = yStart; y <= yEnd; y++) years.add(y);

    const autoFixedFr = (y: number) => [
      `${y}-01-01`, // Jour de l'an
      `${y}-05-01`, // Fête du travail
      `${y}-05-08`, // Victoire 1945
      `${y}-07-14`, // Fête nationale
      `${y}-08-15`, // Assomption
      `${y}-11-01`, // Toussaint
      `${y}-11-11`, // Armistice
      `${y}-12-25`, // Noël
    ];

    const holidaysSet = new Set<string>();
    if (body.autoHolidays) {
      for (const y of years) for (const d of autoFixedFr(y)) holidaysSet.add(d);
      // NB : on ne calcule pas ici les fêtes mobiles (Pâques, Ascension, Pentecôte)
    }
    for (const d of body.holidays ?? []) holidaysSet.add(d);

    // --- Créer la période ---
    // Schéma actuel connu: periods(id, label, open_at)
    const { data: pRows, error: pErr } = await supabase
      .from('periods')
      .insert([{ label: body.label, open_at: body.openAt }])
      .select('id')
      .limit(1);

    if (pErr) {
      return NextResponse.json({ ok: false, error: pErr.message }, { status: 500 });
    }
    const period_id = pRows![0].id as string;

    // --- (Sécurité) supprimer d'éventuels slots existants pour cette période ---
    await supabase.from('slots').delete().eq('period_id', period_id);

    // --- Générer les slots selon les règles métier ---
    const slots: SlotRow[] = [];

    function addSlot(date: string, sh: number, sm: number, eh: number, em: number, kind: string) {
      const start = `${date} ${pad2(sh)}:${pad2(sm)}:00`;
      let endDate = date;
      if (eh === 0 && em === 0) {
        // 00:00 => lendemain
        endDate = addDaysStr(date, 1);
      }
      const end = `${endDate} ${pad2(eh)}:${pad2(em)}:00`;
      slots.push({ period_id, date, start_ts: start, end_ts: end, kind });
    }

    for (const date of eachDateStr(body.startDate, body.endDate)) {
      const isHoliday = holidaysSet.has(date);
      const dow = weekdayFromYMD(date); // 0=dim, 6=sam

      if (isHoliday || dow === 0) {
        // Dimanche / Férié : 08–14, 14–20, 20–24
        addSlot(date, 8, 0, 14, 0, 'SUN_08_14');
        addSlot(date, 14, 0, 20, 0, 'SUN_14_20');
        addSlot(date, 20, 0, 0, 0, 'SUN_20_24');
      } else if (dow === 6) {
        // Samedi : 12–18, 18–00
        addSlot(date, 12, 0, 18, 0, 'SAT_12_18');
        addSlot(date, 18, 0, 0, 0, 'SAT_18_00');
      } else {
        // Lun–Ven : 20–00
        addSlot(date, 20, 0, 0, 0, 'WEEKDAY_20_00');
      }
    }

    // --- Insert en base ---
    if (slots.length > 0) {
      const { error: sErr } = await supabase.from('slots').insert(slots);
      if (sErr) {
        return NextResponse.json(
          { ok: false, error: `Insertion slots: ${sErr.message}` },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({
      ok: true,
      period_id,
      slots_created: slots.length,
    });
  } catch (err: any) {
    console.error('generate-slots error:', err);
    return NextResponse.json(
      { ok: false, error: err?.message ?? 'Unexpected error' },
      { status: 500 }
    );
  }
}

export async function GET() {
  // pour vérif rapide
  return NextResponse.json({ ok: true, hint: 'POST with payload to generate.' });
}
