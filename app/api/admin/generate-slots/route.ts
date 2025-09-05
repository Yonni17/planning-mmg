// app/api/admin/generate-slots/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------- Types ----------
type Payload = {
  label: string;
  startDate: string;   // 'YYYY-MM-DD'
  endDate: string;     // 'YYYY-MM-DD'
  openAt: string;      // 'YYYY-MM-DDTHH:mm'
  closeAt?: string;    // facultatif (non stocké ici)
  generateAt?: string; // facultatif (non stocké ici)
  timezone?: string;   // ex: 'Europe/Paris' (non utilisé côté DB)
  holidays?: string[]; // 'YYYY-MM-DD'
  autoHolidays?: boolean;
};

type SlotRow = {
  period_id: string;
  date: string;     // 'YYYY-MM-DD'
  start_ts: string; // 'YYYY-MM-DD HH:mm:ss'
  end_ts: string;   // 'YYYY-MM-DD HH:mm:ss'
  kind: string;     // WEEKDAY_20_00 | SAT_12_18 | SAT_18_00 | SUN_08_14 | SUN_14_20 | SUN_20_24
};

// ---------- Auth helpers (Bearer / cookies) ----------
function getAccessTokenFromReq(req: NextRequest): string | null {
  // 1) Authorization: Bearer <jwt>
  const auth = req.headers.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

  // 2) Cookie direct sb-access-token (supabase-js côté client)
  const c = cookies();
  const direct = c.get('sb-access-token')?.value;
  if (direct) return direct;

  // 3) Cookie objet sb-<ref>-auth-token (Helpers) éventuellement splitté .0/.1
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
  try {
    const ref = new URL(supabaseUrl).host.split('.')[0];
    const base = `sb-${ref}-auth-token`;
    const c0 = c.get(`${base}.0`)?.value ?? '';
    const c1 = c.get(`${base}.1`)?.value ?? '';
    const cj = c.get(base)?.value ?? '';
    const raw = c0 || c1 ? `${c0}${c1}` : cj;
    if (!raw) return null;

    let txt = raw;
    try { txt = decodeURIComponent(raw); } catch {}
    const parsed = JSON.parse(txt);
    if (parsed?.access_token) return String(parsed.access_token);
    if (parsed?.currentSession?.access_token) return String(parsed.currentSession.access_token);
  } catch {
    // ignore
  }
  return null;
}

async function requireAdminOrResponse(req: NextRequest) {
  const supabase = getSupabaseAdmin();

  const token = getAccessTokenFromReq(req);
  if (!token) {
    return {
      errorResponse: NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 }),
      supabase,
      userId: null as string | null,
    };
  }

  const { data: userData, error: uErr } = await supabase.auth.getUser(token);
  if (uErr || !userData?.user) {
    return {
      errorResponse: NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 }),
      supabase,
      userId: null,
    };
  }

  const uid = userData.user.id;
  const { data: isAdmin, error: aErr } = await supabase.rpc('is_admin', { uid });
  if (aErr || !isAdmin) {
    return {
      errorResponse: NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 }),
      supabase,
      userId: uid,
    };
  }

  return { errorResponse: null as NextResponse | null, supabase, userId: uid };
}

// ---------- Utils dates ----------
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

// ---------- Handler ----------
export async function POST(req: NextRequest) {
  try {
    const { errorResponse, supabase } = await requireAdminOrResponse(req);
    if (errorResponse) return errorResponse;

    const body = (await req.json()) as Partial<Payload>;
    if (!body.label || !body.startDate || !body.endDate || !body.openAt) {
      return NextResponse.json(
        { ok: false, error: 'Champs requis manquants (label, startDate, endDate, openAt).' },
        { status: 400 }
      );
    }

    // Jours fériés FR fixes (sans fêtes mobiles)
    const years = new Set<number>();
    for (let y = +body.startDate.slice(0, 4); y <= +body.endDate.slice(0, 4); y++) years.add(y);
    const autoFixedFr = (y: number) => [
      `${y}-01-01`, // Jour de l'An
      `${y}-05-01`, // Fête du Travail
      `${y}-05-08`, // Victoire 1945
      `${y}-07-14`, // Fête nationale
      `${y}-08-15`, // Assomption
      `${y}-11-01`, // Toussaint
      `${y}-11-11`, // Armistice
      `${y}-12-25`, // Noël
    ];
    const holidaysSet = new Set<string>();
    if (body.autoHolidays) for (const y of years) for (const d of autoFixedFr(y)) holidaysSet.add(d);
    for (const d of body.holidays ?? []) holidaysSet.add(d);

    // Crée la période
    const { data: pRows, error: pErr } = await supabase
      .from('periods')
      .insert([{ label: body.label, open_at: body.openAt }])
      .select('id')
      .limit(1);

    if (pErr) {
      return NextResponse.json({ ok: false, error: `Insertion période: ${pErr.message}` }, { status: 500 });
    }
    const period_id = pRows![0].id as string;

    // (Sécurité) purge slots existants pour cette période (si jamais)
    await supabase.from('slots').delete().eq('period_id', period_id);

    // Génère les slots selon règles:
    // lun–ven 20–00, sam 12–18 & 18–00, dim/feriés 08–14, 14–20, 20–24
    const slots: SlotRow[] = [];
    const addSlot = (date: string, sh: number, sm: number, eh: number, em: number, kind: string) => {
      const start = `${date} ${pad2(sh)}:${pad2(sm)}:00`;
      let endDate = date;
      if (eh === 0 && em === 0) endDate = addDaysStr(date, 1); // 00:00 = lendemain
      const end = `${endDate} ${pad2(eh)}:${pad2(em)}:00`;
      slots.push({ period_id, date, start_ts: start, end_ts: end, kind });
    };

    for (const date of eachDateStr(body.startDate, body.endDate)) {
      const dow = weekdayFromYMD(date);
      const isHoliday = holidaysSet.has(date);

      if (isHoliday || dow === 0) {
        // Dimanches & fériés : 3 créneaux
        addSlot(date, 8, 0, 14, 0, 'SUN_08_14');
        addSlot(date, 14, 0, 20, 0, 'SUN_14_20');
        addSlot(date, 20, 0, 0, 0, 'SUN_20_24');
      } else if (dow === 6) {
        // Samedi : 2 créneaux
        addSlot(date, 12, 0, 18, 0, 'SAT_12_18');
        addSlot(date, 18, 0, 0, 0, 'SAT_18_00');
      } else {
        // Semaine : 1 créneau
        addSlot(date, 20, 0, 0, 0, 'WEEKDAY_20_00');
      }
    }

    if (slots.length) {
      const { error: sErr } = await supabase.from('slots').insert(slots);
      if (sErr) {
        return NextResponse.json({ ok: false, error: `Insertion slots: ${sErr.message}` }, { status: 500 });
      }
    }

    return NextResponse.json({ ok: true, period_id, slots_created: slots.length });
  } catch (err: any) {
    console.error('generate-slots error:', err);
    return NextResponse.json({ ok: false, error: err?.message ?? 'Unexpected error' }, { status: 500 });
  }
}

// Petit endpoint GET facultatif (diagnostic)
export async function GET() {
  return NextResponse.json({ ok: true, hint: 'POST label/startDate/endDate/openAt (+options) pour générer une période + slots.' });
}
