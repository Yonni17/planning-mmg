// app/api/admin/cron/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Déclenchement manuel possible: /api/admin/cron?key=TA_CLE
const CRON_SECRET = process.env.CRON_SECRET ?? '';

// ------------------ utils dates (UTC) ------------------
function startOfQuarter(d: Date) {
  const m = d.getUTCMonth();                 // 0..11
  const q = Math.floor(m / 3);               // 0..3
  const m0 = q * 3;
  return new Date(Date.UTC(d.getUTCFullYear(), m0, 1, 0, 0, 0));
}
function addMonthsUTC(d: Date, months: number) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate(), 0, 0, 0));
}
function endOfQuarter(qStart: Date) {
  const nextQ = addMonthsUTC(qStart, 3);
  // dernier jour inclus (23:59:59.999Z)
  return new Date(nextQ.getTime() - 1);
}
function addDaysUTC(d: Date, n: number) {
  return new Date(d.getTime() + n * 24 * 3600 * 1000);
}
function ymdUTC(d: Date) {
  return d.toISOString().slice(0, 10);
}
function dayOfWeekUTC(d: Date) {
  return d.getUTCDay(); // 0=dim..6=sam
}
// -------------------------------------------------------

type SlotSpec = { kind: string; start: string; end: string };
type SlotInsert = { period_id: string; date: string; start_ts: string; end_ts: string; kind: string };

function slotsForDay(d: Date): SlotSpec[] {
  const dow = dayOfWeekUTC(d);
  if (dow >= 1 && dow <= 5) return [{ kind: 'WEEKDAY_20_00', start: '20:00', end: '00:00' }];
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

// Construit un timestamp ISO UTC à partir de YYYY-MM-DD + HH:mm
function isoUTC(ymd: string, hhmm: string) {
  return new Date(`${ymd}T${hhmm}:00Z`).toISOString();
}

export async function GET(req: NextRequest) {
  const supa = getSupabaseAdmin();
  const now = new Date(); // UTC

  // Autoriser :
  // - les jobs (GitHub Actions / Vercel) qui envoient la requête
  // - OU l'appel manuel avec ?key=CRON_SECRET
  const hasVercelHeader = req.headers.get('x-vercel-cron') !== null;
  const keyMatches = !!CRON_SECRET && req.nextUrl.searchParams.get('key') === CRON_SECRET;
  if (!hasVercelHeader && !keyMatches) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Defaults / réglages globaux
  let openLeadDays = 45;      // J-45 : création auto de la période + slots
  let planningLeadDays = 21;  // J-21 : génération planning (rempli generate_at)
  try {
    const { data } = await supa
      .from('automation_settings')
      .select('settings')
      .eq('key', 'global')
      .maybeSingle();
    const s = (data as any)?.settings ?? {};
    if (Number.isFinite(s?.open_lead_days)) openLeadDays = Number(s.open_lead_days);
    if (Number.isFinite(s?.planning_generate_before_days)) planningLeadDays = Number(s.planning_generate_before_days);
  } catch {
    // on garde les defaults
  }

  // Trimestre courant + 3 suivants
  const candidates: { start: Date; end: Date; label: string }[] = [];
  const q0 = startOfQuarter(now);
  for (let i = 0; i < 4; i++) {
    const start = addMonthsUTC(q0, i * 3);
    const end = endOfQuarter(start);
    const qIndex = Math.floor(start.getUTCMonth() / 3) + 1; // 1..4
    candidates.push({ start, end, label: `T${qIndex} ${start.getUTCFullYear()}` });
  }

  let created: null | { period_id: string; label: string; slots: number } = null;
  let note: string = 'no-op';

  try {
    for (const cand of candidates) {
      const openFrom = addDaysUTC(cand.start, -openLeadDays);

      // Crée si non existant ET on est dans la fenêtre [J-45 ; J0[
      if (now >= openFrom && now < cand.start) {
        const { data: p0 } = await supa
          .from('periods')
          .select('id')
          .eq('label', cand.label)
          .maybeSingle();
        if (p0?.id) { note = 'no-op (already exists)'; continue; }

        // close_at = fin de trimestre (23:59:59.999Z)
        const closeAt = endOfQuarter(cand.start).toISOString();
        // generate_at = J - planningLeadDays (00:00:00Z)
        const generateAt = addDaysUTC(cand.start, -planningLeadDays).toISOString();

        // Créer la période (respect des NOT NULL: label, open_at, close_at, generate_at)
        const { data: insP, error: pErr } = await supa
          .from('periods')
          .insert([{
            label:       cand.label,
            open_at:     cand.start.toISOString(), // 1er jour du trimestre
            close_at:    closeAt,                  // fin de trimestre
            generate_at: generateAt                // date cible pour la génération du planning
          }])
          .select('id')
          .maybeSingle();

        if (pErr || !insP?.id) {
          throw new Error(pErr?.message || 'insert period failed');
        }
        const period_id = String(insP.id);

        // Générer les slots
        const rows: SlotInsert[] = [];
        for (let d = new Date(cand.start); d <= cand.end; d = addDaysUTC(d, 1)) {
          const ymd = ymdUTC(d);
          for (const s of slotsForDay(d)) {
            const start_ts = isoUTC(ymd, s.start);
            const endYmd = s.end === '00:00' ? ymdUTC(addDaysUTC(d, 1)) : ymd;
            const end_ts = isoUTC(endYmd, s.end);
            rows.push({ period_id, date: ymd, start_ts, end_ts, kind: s.kind });
          }
        }

        if (rows.length) {
          const { error: sErr } = await supa.from('slots').insert(rows);
          if (sErr) throw new Error(sErr.message);
        }

        created = { period_id, label: cand.label, slots: rows.length };
        note = 'created';
        break;
      }
    }

    // Log OK / noop
    await supa.from('cron_runs').insert([{
      run_at: new Date().toISOString(),
      created_period_id: created?.period_id ?? null,
      created_label: created?.label ?? null,
      created_slots: created?.slots ?? null,
      note,
      error: null
    }]);

    return NextResponse.json({ ok: true, created, note });
  } catch (e: any) {
    // Log erreur
    const message = e?.message ?? String(e);
    await supa.from('cron_runs').insert([{
      run_at: new Date().toISOString(),
      created_period_id: null,
      created_label: null,
      created_slots: null,
      note: 'error',
      error: message
    }]);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
