// app/api/admin/automation-tick/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { sendEmail } from '@/lib/email';
import { emailTemplates } from '@/lib/emailTemplates';

export const dynamic = 'force-dynamic';

// ---------- Réglages ----------
const PARIS_TZ = 'Europe/Paris';
const MIN_GAP_MS = Number(process.env.EMAIL_MIN_GAP_MS ?? 700); // throttle ~1.4 rps
const MAX_RETRIES = 3;

// ---------- Utils ----------
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
const toParis = (d: Date) => new Date(d.toLocaleString('en-US', { timeZone: PARIS_TZ }));

function isoHourKey(d: Date) {
  // Clé d'heure UTC: YYYY-MM-DDTHH
  return d.toISOString().slice(0, 13);
}
function weekKeyParis(d: Date) {
  const local = toParis(d);
  // Semaine ISO approximative suffisante pour clé d'idempotence
  const year = local.getFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dow = (local.getDay() + 6) % 7; // 0=Lundi
  const thursday = new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate() - dow + 3));
  const week = Math.floor(1 + (thursday.getTime() - jan4.getTime()) / 604800000);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

async function alreadyLogged(periodId: string, eventType: string, windowKey: string, target: string) {
  const { data, error } = await supabase
    .from('automation_email_log')
    .select('id')
    .eq('period_id', periodId)
    .eq('event_type', eventType)
    .eq('window_key', windowKey)
    .eq('target', target)
    .maybeSingle();
  if (error && (error as any).code !== 'PGRST116') console.error('alreadyLogged error', error);
  return !!data;
}
async function logSent(periodId: string, eventType: string, windowKey: string, target: string, meta: any = {}) {
  const { error } = await supabase
    .from('automation_email_log')
    .insert({ period_id: periodId, event_type: eventType, window_key: windowKey, target, meta });
  if (error) {
    console.error('logSent error', error);
    // remonter l'erreur pour que l’API signale le problème (ex: RLS)
    throw error;
  }
}

async function sendOne(to: string, subject: string, html: string) {
  let attempt = 0;
  // retries + backoff
  while (attempt < MAX_RETRIES) {
    attempt++;
    try {
      await sendEmail({ to, subject, html });
      return true;
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (msg.includes('429') && attempt < MAX_RETRIES) {
        await sleep(1200 * attempt);
      } else {
        console.error('sendEmail error to', to, e);
        return false;
      }
    }
  }
  return false;
}

async function sendBulkIndividually(
  periodId: string,
  eventType: string,
  windowKey: string,
  recipients: { email: string, user_id?: string }[],
  build: (r: { email: string, user_id?: string }) => { subject: string, html: string, meta?: any },
  dryRun: boolean
) {
  let sent = 0;
  for (const r of recipients) {
    const target = r.email;
    const done = await alreadyLogged(periodId, eventType, windowKey, target);
    if (done) continue;

    if (!dryRun) {
      const { subject, html, meta } = build(r);
      const ok = await sendOne(r.email, subject, html);
      if (ok) {
        sent++;
        await logSent(periodId, eventType, windowKey, target, meta ?? {});
      }
      await sleep(MIN_GAP_MS);
    }
  }
  return sent;
}

// --- Récup: périodes + automation ---
async function fetchActivePeriods() {
  // periods + period_automation (INNER: on exige une ligne d'automatisation)
  const { data, error } = await supabase
    .from('periods')
    .select('id, label, open_at, close_at, timezone, generate_at, period_automation!inner(*)');
  if (error) throw error;
  return (data ?? []).map((p: any) => ({
    id: p.id as string,
    label: p.label as string,
    tz: (p.timezone as string) || PARIS_TZ,
    open_at: new Date(p.open_at),
    close_at: new Date(p.close_at),
    automation: p.period_automation
  }));
}

// --- Destinataires: rappels planning (non verrouillés) ---
// Stratégie: essayer la vue; si elle échoue ou renvoie 0 → fallback direct sur les tables.
async function fetchRecipientsPlanning(periodId: string, wantDebug = false) {
  // 1) Tentative par la vue
  {
    const { data, error } = await supabase
      .from('v_period_doctors_to_remind')
      .select('user_id, email, all_months_done, any_optout')
      .eq('period_id', periodId);

    if (!error && Array.isArray(data)) {
      const recips = (data ?? [])
        .filter((r: any) => r?.email && r.all_months_done === false && r.any_optout === false)
        .map((r: any) => ({ user_id: r.user_id as string, email: r.email as string }));
      if (wantDebug) console.log('[recips:view]', { periodId, count: recips.length });
      if (recips.length > 0) return recips;
      // sinon try fallback
    } else {
      if (wantDebug) console.error('[recips:view:error]', error);
    }
  }

  // 2) Fallback: jointure directe doctor_period_months + profiles
  //    Logique: docteurs ayant AU MOINS un mois non verrouillé et pas opt-out sur la période.
  {
    const { data, error } = await supabase
      .from('doctor_period_months')
      .select('user_id, locked, opted_out, profiles!inner(user_id,email,role)')
      .eq('period_id', periodId)
      .eq('locked', false)
      .or('opted_out.is.null,opted_out.eq.false') // opted_out null ou false
      .eq('profiles.role', 'doctor')
      .not('profiles.email', 'is', null);

    if (error) {
      if (wantDebug) console.error('[recips:fallback:error]', error);
      return [];
    }

    // dédoublonner par user_id (un user peut avoir plusieurs mois ouverts)
    const uniq = new Map<string, { user_id: string; email: string }>();
    for (const r of (data ?? [])) {
      const email = (r as any)?.profiles?.email as string | null;
      const uid = (r as any)?.user_id as string;
      if (email) uniq.set(uid, { user_id: uid, email });
    }
    const recips = Array.from(uniq.values());
    if (wantDebug) console.log('[recips:fallback]', { periodId, count: recips.length });
    return recips;
  }
}

// --- Destinataires: rappel J-1 de garde (assignments publiés) ---
async function fetchAssignmentsJ1(now: Date) {
  // Cherche les slots dans ~[24h, 25h) pour fenêtre 1h, state='published'
  const from = new Date(now.getTime() + 24 * 3600 * 1000);
  const to = new Date(now.getTime() + 25 * 3600 * 1000);

  const { data, error } = await supabase
    .from('assignments')
    .select(`
      slot_id,
      user_id,
      state,
      period_id,
      slots!inner(id, period_id, start_ts, end_ts, kind),
      profiles!inner(user_id, email)
    `)
    .eq('state', 'published')
    .gte('slots.start_ts', from.toISOString())
    .lt('slots.start_ts', to.toISOString())
    .not('user_id', 'is', null);

  if (error) {
    console.error('fetchAssignmentsJ1 error', error);
    return [];
  }

  return (data ?? []).map((r: any) => ({
    period_id: r.period_id as string,
    slot_id: r.slot_id as string,
    start_ts: r.slots.start_ts as string,
    end_ts: r.slots.end_ts as string,
    kind: r.slots.kind as string,
    user_id: r.user_id as string,
    email: r.profiles?.email as string
  })).filter(x => !!x.email);
}

// --- Point d’entrée GET ---
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const dryRun = searchParams.get('dry-run') === '1';
  const wantDebug = searchParams.get('debug') === '1';

  try {
    const now = new Date();
    const periods = await fetchActivePeriods();
    let totalToSend = 0;
    let totalSent = 0;
    const debug: any[] = [];

    // =========================
    // A) Rappels “complétion planning”
    // =========================
    for (const p of periods) {
      const a = p.automation;
      const periodId = p.id;

      // 1) Weekly (lundi 09:00 Europe/Paris)
      if (a.weekly_reminder) {
        const local = toParis(now);
        const isMonday = local.getDay() === 1;
        const is09 = local.getHours() === 9;
        if (isMonday && is09) {
          const wk = weekKeyParis(now);
          const recips = await fetchRecipientsPlanning(periodId, wantDebug);
          totalToSend += recips.length;

          if (!dryRun) {
            const sent = await sendBulkIndividually(
              periodId, 'weekly', wk, recips,
              () => {
                const tpl = emailTemplates.weekly({
                  periodLabel: p.label,
                  deadlineAt: a.avail_deadline ?? p.close_at
                });
                return { subject: tpl.subject, html: tpl.html, meta: { type: 'weekly' } };
              },
              dryRun
            );
            totalSent += sent;
          }
          if (wantDebug || dryRun) {
            debug.push({ type: 'weekly', periodId, key: wk, recipients: recips.map(r => r.email) });
          }
        }
      }

      // 2) Deadlines planning (H-48, H-24, H-1)
      const deadline = a.avail_deadline ? new Date(a.avail_deadline) : new Date(p.close_at);
      const hoursBefore = Array.isArray(a.extra_reminder_hours) && a.extra_reminder_hours.length
        ? a.extra_reminder_hours
        : [48, 24, 1];

      for (const h of hoursBefore) {
        const windowStart = new Date(deadline.getTime() - h * 3600 * 1000);
        const windowEnd = new Date(windowStart.getTime() + 3600 * 1000); // fenêtre 1h
        if (now >= windowStart && now < windowEnd) {
          const key = `${deadline.toISOString()}:${h}h`; // window_key unique par (deadline, h)

          const recips = await fetchRecipientsPlanning(periodId, wantDebug);
          totalToSend += recips.length;

          if (!dryRun) {
            const type = h === 48 ? 'deadline_48' : h === 24 ? 'deadline_24' : 'deadline_1';
            const sent = await sendBulkIndividually(
              periodId, type, key, recips,
              () => {
                const tpl =
                  h === 48 ? emailTemplates.deadline_48({ periodLabel: p.label, deadlineAt: deadline }) :
                  h === 24 ? emailTemplates.deadline_24({ periodLabel: p.label, deadlineAt: deadline }) :
                             emailTemplates.deadline_1({ periodLabel: p.label, deadlineAt: deadline });
                return { subject: tpl.subject, html: tpl.html, meta: { deadlineAt: deadline.toISOString(), h } };
              },
              dryRun
            );
            totalSent += sent;
          }
          if (wantDebug || dryRun) {
            debug.push({ type: 'deadline', h, periodId, key, recipients: recips.map(r => r.email) });
          }
        }
      }

      // 3) Opening (optionnel) — si tu veux auto-envoyer à l’ouverture (fenêtre 1h)
      if (a.avail_open_at) {
        const openAt = new Date(a.avail_open_at);
        if (now >= openAt && (now.getTime() - openAt.getTime()) < 3600 * 1000) {
          const windowKey = isoHourKey(openAt); // UTC hour key
          const recips = await fetchRecipientsPlanning(periodId, wantDebug);
          totalToSend += recips.length;

          if (!dryRun) {
            const sent = await sendBulkIndividually(
              periodId, 'opening', windowKey, recips,
              () => {
                const tpl = emailTemplates.opening({ periodLabel: p.label });
                return { subject: tpl.subject, html: tpl.html, meta: { openAt: openAt.toISOString() } };
              },
              dryRun
            );
            totalSent += sent;
          }
          if (wantDebug || dryRun) {
            debug.push({ type: 'opening', periodId, key: windowKey, recipients: recips.map(r => r.email) });
          }
        }
      }
    }

    // =========================
    // B) Rappels “garde demain” (J-1 par assignment publié)
    // =========================
    {
      const assignments = await fetchAssignmentsJ1(now);
      totalToSend += assignments.length;

      for (const a of assignments) {
        const windowKey = `slot:${a.slot_id}`; // 1 seul envoi par slot/assignment
        const already = await alreadyLogged(a.period_id, 'assignment_j1', windowKey, a.email);
        if (already) continue;

        if (!dryRun) {
          const start = new Date(a.start_ts);
          const end = new Date(a.end_ts);
          const tpl = emailTemplates.assignment_j1({ start, end, kind: a.kind });
          const ok = await sendOne(a.email, tpl.subject, tpl.html);
          if (ok) {
            totalSent += 1;
            await logSent(a.period_id, 'assignment_j1', windowKey, a.email, {
              slot_id: a.slot_id,
              start_ts: a.start_ts,
              end_ts: a.end_ts
            });
          }
          await sleep(MIN_GAP_MS);
        }
      }

      if (wantDebug || dryRun) {
        debug.push({
          type: 'assignment_j1',
          count: assignments.length,
          recipients: assignments.map(a => ({ email: a.email, slot_id: a.slot_id, start_ts: a.start_ts }))
        });
      }
    }

    return NextResponse.json({ ok: true, dryRun, totalToSend, totalSent, debug });
  } catch (e: any) {
    console.error('automation-tick fatal', e);
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
