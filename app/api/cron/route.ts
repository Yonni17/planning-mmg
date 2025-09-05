// app/api/admin/cron/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Sécurité très simple : /api/admin/cron?key=...
const CRON_SECRET = process.env.CRON_SECRET!;

function startOfQuarter(d: Date) {
  const month = d.getUTCMonth(); // 0..11
  const q = Math.floor(month / 3); // 0..3
  const m0 = q * 3;
  return new Date(Date.UTC(d.getUTCFullYear(), m0, 1, 0, 0, 0));
}
function addMonthsUTC(d: Date, months: number) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate(), 0, 0, 0));
}
function endOfQuarter(d: Date) {
  const start = startOfQuarter(d);
  const nextQ = addMonthsUTC(start, 3);
  // dernier jour inclus
  const end = new Date(nextQ.getTime() - 24 * 3600 * 1000);
  return end;
}
function ymdUTC(d: Date) {
  return d.toISOString().slice(0, 10);
}
function addDaysUTC(d: Date, n: number) {
  return new Date(d.getTime() + n * 24 * 3600 * 1000);
}
function dayOfWeekUTC(d: Date) {
  return d.getUTCDay(); // 0=dim,..6=sam
}

type SlotSpec = { kind: string; start: string; end: string };

function slotsForDay(d: Date): SlotSpec[] {
  const dow = dayOfWeekUTC(d);
  if (dow >= 1 && dow <= 5) {
    return [{ kind: 'WEEKDAY_20_00', start: '20:00', end: '00:00' }];
  }
  if (dow === 6) {
    return [
      { kind: 'SAT_12_18', start: '12:00', end: '18:00' },
      { kind: 'SAT_18_00', start: '18:00', end: '00:00' },
    ];
  }
  // dimanche
  return [
    { kind: 'SUN_08_14', start: '08:00', end: '14:00' },
    { kind: 'SUN_14_20', start: '14:00', end: '20:00' },
    { kind: 'SUN_20_24', start: '20:00', end: '00:00' },
  ];
}

// Construit un timestamp ISO en UTC (on stocke aussi la colonne "date" locale YYYY-MM-DD)
function isoUTC(ymd: string, hhmm: string) {
  return new Date(`${ymd}T${hhmm}:00Z`).toISOString();
}

export async function GET(req: NextRequest) {
  if (!CRON_SECRET || req.nextUrl.searchParams.get('key') !== CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supa = getSupabaseAdmin();

  // Paramètre global (fallback 45)
  let openLeadDays = 45;
  try {
    const { data } = await supa.from('automation_settings').select('settings').eq('key', 'global').maybeSingle();
    const val = data?.settings?.open_lead_days;
    if (Number.isFinite(val)) openLeadDays = Number(val);
  } catch {}

  const now = new Date(); // UTC

  // On regarde les 4 prochains trimestres (à partir du courant)
  const candidates: { start: Date; end: Date; label: string }[] = [];
  let qStart = startOfQuarter(now);
  for (let i = 0; i < 4; i++) {
    const start = addMonthsUTC(qStart, i * 3);
    const end = endOfQuarter(start);
    const qIndex = Math.floor(start.getUTCMonth() / 3) + 1; // 1..4
    const label = `T${qIndex} ${start.getUTCFullYear()}`;
    candidates.push({ start, end, label });
  }

  let created: null | { period_id: string; label: string; slots: number } = null;

  for (const cand of candidates) {
    const openFrom = addDaysUTC(cand.start, -openLeadDays);
    // On crée si : pas encore existant ET now est entre J-45 inclus et le 1er jour de trimestre (sécurité)
    if (now >= openFrom && now < cand.start) {
      // Existant ?
      const { data: p0 } = await supa.from('periods').select('id').eq('label', cand.label).maybeSingle();
      if (p0?.id) continue;

      // Créer la période
      const { data: insP, error: pErr } = await supa
        .from('periods')
        .insert([{ label: cand.label, open_at: cand.start.toISOString() }])
        .select('id')
        .maybeSingle();
      if (pErr || !insP?.id) {
        return NextResponse.json({ error: pErr?.message || 'insert period failed' }, { status: 500 });
      }

      const period_id = insP.id as string;

      // Générer les slots
      const rows: any[] = [];
      for (let d = cand.start; d <= cand.end; d = addDaysUTC(d, 1)) {
        const ymd = ymdUTC(d);
        for (const s of slotsForDay(d)) {
          const start_ts = isoUTC(ymd, s.start);
          const end_ymd = s.end === '00:00' ? ymdUTC(addDaysUTC(d, 1)) : ymd;
          const end_ts = isoUTC(end_ymd, s.end === '00:00' ? '00:00' : s.end);
          rows.push({
            period_id,
            date: ymd,         // colonne locale pour le groupement
            start_ts,
            end_ts,
            kind: s.kind,
          });
        }
      }

      if (rows.length) {
        const { error: sErr } = await supa.from('slots').insert(rows);
        if (sErr) return NextResponse.json({ error: sErr.message }, { status: 500 });
      }

      created = { period_id, label: cand.label, slots: rows.length };
      break;
    }
  }

  return NextResponse.json({ ok: true, created });
}
