// app/api/admin/generate-slots/route.ts
import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DAY_MS = 24 * 60 * 60 * 1000;
const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

function addDaysStr(yyyy_mm_dd: string, days: number): string {
  const d = new Date(`${yyyy_mm_dd}T12:00:00Z`);
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
  const d = new Date(`${yyyy_mm_dd}T12:00:00Z`);
  return d.getUTCDay(); // 0=dim, 6=sam
}

type Payload = {
  label: string;
  startDate: string;
  endDate: string;
  openAt: string;
  closeAt?: string;
  generateAt?: string;
  timezone?: string;
  holidays?: string[];
  autoHolidays?: boolean;
};

type SlotRow = {
  period_id: string;
  date: string;
  start_ts: string;
  end_ts: string;
  kind: string;
};

export async function POST(req: Request) {
  try {
    const supabase = getSupabaseAdmin();

    const body = (await req.json()) as Partial<Payload>;
    if (!body.label || !body.startDate || !body.endDate || !body.openAt) {
      return NextResponse.json(
        { ok: false, error: 'Champs requis manquants (label, startDate, endDate, openAt).' },
        { status: 400 }
      );
    }

    const years = new Set<number>();
    for (let y = +body.startDate.slice(0, 4); y <= +body.endDate.slice(0, 4); y++) years.add(y);
    const autoFixedFr = (y: number) => [
      `${y}-01-01`, `${y}-05-01`, `${y}-05-08`, `${y}-07-14`,
      `${y}-08-15`, `${y}-11-01`, `${y}-11-11`, `${y}-12-25`,
    ];
    const holidaysSet = new Set<string>();
    if (body.autoHolidays) for (const y of years) for (const d of autoFixedFr(y)) holidaysSet.add(d);
    for (const d of body.holidays ?? []) holidaysSet.add(d);

    const { data: pRows, error: pErr } = await supabase
      .from('periods')
      .insert([{ label: body.label, open_at: body.openAt }])
      .select('id')
      .limit(1);

    if (pErr) return NextResponse.json({ ok: false, error: pErr.message }, { status: 500 });
    const period_id = pRows![0].id as string;

    await supabase.from('slots').delete().eq('period_id', period_id);

    const slots: SlotRow[] = [];
    const addSlot = (date: string, sh: number, sm: number, eh: number, em: number, kind: string) => {
      const start = `${date} ${pad2(sh)}:${pad2(sm)}:00`;
      let endDate = date;
      if (eh === 0 && em === 0) endDate = addDaysStr(date, 1);
      const end = `${endDate} ${pad2(eh)}:${pad2(em)}:00`;
      slots.push({ period_id, date, start_ts: start, end_ts: end, kind });
    };

    for (const date of eachDateStr(body.startDate, body.endDate)) {
      const dow = weekdayFromYMD(date);
      const isHoliday = holidaysSet.has(date);
      if (isHoliday || dow === 0) {
        addSlot(date, 8, 0, 14, 0, 'SUN_08_14');
        addSlot(date, 14, 0, 20, 0, 'SUN_14_20');
        addSlot(date, 20, 0, 0, 0, 'SUN_20_24');
      } else if (dow === 6) {
        addSlot(date, 12, 0, 18, 0, 'SAT_12_18');
        addSlot(date, 18, 0, 0, 0, 'SAT_18_00');
      } else {
        addSlot(date, 20, 0, 0, 0, 'WEEKDAY_20_00');
      }
    }

    if (slots.length) {
      const { error: sErr } = await supabase.from('slots').insert(slots);
      if (sErr) return NextResponse.json({ ok: false, error: `Insertion slots: ${sErr.message}` }, { status: 500 });
    }

    return NextResponse.json({ ok: true, period_id, slots_created: slots.length });
  } catch (err: any) {
    console.error('generate-slots error:', err);
    return NextResponse.json({ ok: false, error: err?.message ?? 'Unexpected error' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, hint: 'POST with payload to generate.' });
}
