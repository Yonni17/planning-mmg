// app/api/admin/automation-tick/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin'; // client "service role"
import * as TPL from '@/lib/emailTemplates';            // <-- noms exacts des templates
import { sendEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';

// --------- Client admin (bypass RLS) ---------
const supabase = getSupabaseAdmin();

// --------- Réglages ---------
const PARIS_TZ = 'Europe/Paris';
const MIN_GAP_MS = Number(process.env.EMAIL_MIN_GAP_MS ?? 700);
const MAX_RETRIES = 3;
// URL du site pour les liens dans les emails
const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '') ||
  'https://planning-mmg.ovh';

// --------- Utils ---------
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

/** Convertit un Date "now" en équivalent Europe/Paris, mais en Date UTC (pour getUTC*) */
function toTZ(d: Date, tz: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d);
  const map: Record<string, string> = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return new Date(Date.UTC(
    Number(map.year), Number(map.month) - 1, Number(map.day),
    Number(map.hour), Number(map.minute), Number(map.second)
  ));
}
function isoHourKey(d: Date) { return d.toISOString().slice(0, 13); }
function weekKeyParis(d: Date) {
  const local = toTZ(d, PARIS_TZ);
  const year = local.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dow = local.getUTCDay(); // 0=Dim, 1=Lun...
  const thursday = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - ((dow + 6) % 7) + 3));
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
    throw error;
  }
}

async function sendOne(to: string, subject: string, html: string) {
  let attempt = 0;
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
type AutomationRow = {
  avail_open_at?: string | null;
  avail_deadline?: string | null;
  avail_deadline_before_days?: number | null;
  weekly_reminder?: boolean | null;
  extra_reminder_hours?: number[] | null;
};
function pickAutomationRow(a: any): AutomationRow | null {
  if (!a) return null;
  return Array.isArray(a) ? (a[0] ?? null) : a;
}
async function fetchActivePeriods() {
  const { data, error } = await supabase
    .from('periods')
    .select('id, label, open_at, close_at, timezone, generate_at, period_automation!inner(*)');
  if (error) throw error;
  return (data ?? []).map((p: any) => {
    const automation = pickAutomationRow(p.period_automation);
    return {
      id: p.id as string,
      label: p.label as string,
      tz: (p.timezone as string) || PARIS_TZ,
      open_at: new Date(p.open_at),
      close_at: new Date(p.close_at),
      automation,
    };
  }).filter(p => !!p.automation);
}

// --- Destinataires: uniquement doctors avec au moins 1 mois non verrouillé ---
async function fetchRecipientsPlanning(periodId: string, wantDebug = false) {
  const { data, error } = await supabase
    .from('doctor_period_months')
    .select('user_id, locked, opted_out, profiles!inner(user_id,email,role)')
    .eq('period_id', periodId)
    .eq('locked', false)
    .or('opted_out.is.null,opted_out.eq.false')
    .eq('profiles.role', 'doctor')
    .not('profiles.email', 'is', null);

  if (error) {
    if (wantDebug) console.error('[recips:error]', error);
    return [];
  }

  const uniq = new Map<string, { user_id: string; email: string }>();
  for (const r of (data ?? [])) {
    const email = (r as any)?.profiles?.email as string | null;
    const uid = (r as any)?.user_id as string;
    if (email) uniq.set(uid, { user_id: uid, email });
  }
  const recips = Array.from(uniq.values());
  if (wantDebug) console.log('[recips]', { periodId, count: recips.length, emails: recips.map(x => x.email) });
  return recips;
}

// --- Destinataires: rappel J-1 de garde ---
async function fetchAssignmentsJ1(now: Date) {
  const from = new Date(now.getTime() + 24 * 3600 * 1000);
  const to   = new Date(now.getTime() + 25 * 3600 * 1000);

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

// --- Route GET ---
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const dryRun    = searchParams.get('dry-run') === '1';
  const wantDebug = searchParams.get('debug') === '1';

  try {
    // Sanity check des templates nécessaires (noms réels)
    const must = [
      'emailOpening', 'emailWeeklyReminder',
      'emailDeadline48h', 'emailDeadline24h', 'emailDeadline1h',
      'emailAssignmentJ1',
    ] as const;
    for (const k of must) {
      if (!(k in TPL) || typeof (TPL as any)[k] !== 'function') {
        throw new Error(`Email template manquant: ${k} (dans lib/emailTemplates.ts)`);
      }
    }

    const now = new Date();
    const nowParis = toTZ(now, PARIS_TZ);
    const periods = await fetchActivePeriods();

    let totalToSend = 0;
    let totalSent = 0;
    const debug: any[] = [];

    // ===== A) Rappels complétion planning =====
    for (const p of periods) {
      const a = p.automation as AutomationRow | null;
      const periodId = p.id;

      // 1) Weekly (lundi 09:00 Paris)
      if (a?.weekly_reminder) {
        const isMonday = nowParis.getUTCDay() === 1;
        const is09     = nowParis.getUTCHours() === 9;
        if (wantDebug) debug.push({ type: 'weekly-check', periodId, parisDay: nowParis.getUTCDay(), parisHour: nowParis.getUTCHours(), isMonday, is09 });
        if (isMonday && is09) {
          const wk = weekKeyParis(now);
          const recips = await fetchRecipientsPlanning(periodId, wantDebug);
          totalToSend += recips.length;

          if (!dryRun) {
            const sent = await sendBulkIndividually(
              periodId, 'weekly', wk, recips,
              () => {
                const tpl = TPL.emailWeeklyReminder({
                  periodLabel: p.label,
                  deadline: a.avail_deadline ? new Date(a.avail_deadline) : p.close_at,
                  siteUrl: SITE_URL,
                });
                return { subject: tpl.subject, html: tpl.html, meta: { type: 'weekly' } };
              },
              dryRun
            );
            totalSent += sent;
          }
          if (wantDebug || dryRun) debug.push({ type: 'weekly', periodId, key: wk, recipients: recips.map(r => r.email) });
        }
      }

      // 2) Deadlines (H-48 / H-24 / H-1)
      {
        const deadline = a?.avail_deadline ? new Date(a.avail_deadline) : new Date(p.close_at);
        const hoursBefore = Array.isArray(a?.extra_reminder_hours) && a!.extra_reminder_hours!.length
          ? a!.extra_reminder_hours!
          : [48, 24, 1];

        for (const h of hoursBefore) {
          const windowStart = new Date(deadline.getTime() - h * 3600 * 1000);
          const windowEnd   = new Date(windowStart.getTime() + 3600 * 1000);
          const inWindow    = now >= windowStart && now < windowEnd;
          if (wantDebug) debug.push({ type: 'deadline-check', periodId, h, deadline: deadline.toISOString(), windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString(), now: now.toISOString(), inWindow });
          if (inWindow) {
            const key = `${deadline.toISOString()}:${h}h`;
            const recips = await fetchRecipientsPlanning(periodId, wantDebug);
            totalToSend += recips.length;

            if (!dryRun) {
              const sent = await sendBulkIndividually(
                periodId,
                h === 48 ? 'deadline_48' : h === 24 ? 'deadline_24' : 'deadline_1',
                key,
                recips,
                () => {
                  const base = { periodLabel: p.label, deadline, siteUrl: SITE_URL };
                  const tpl =
                    h === 48 ? TPL.emailDeadline48h(base) :
                    h === 24 ? TPL.emailDeadline24h(base) :
                               TPL.emailDeadline1h (base);
                  return { subject: tpl.subject, html: tpl.html, meta: { deadlineAt: deadline.toISOString(), h } };
                },
                dryRun
              );
              totalSent += sent;
            }
            if (wantDebug || dryRun) debug.push({ type: 'deadline', h, periodId, key, recipients: recips.map(r => r.email) });
          }
        }
      }

      // 3) Opening (fenêtre 1h après avail_open_at)
      if (a?.avail_open_at) {
        const openAt   = new Date(a.avail_open_at);
        const inWindow = now >= openAt && (now.getTime() - openAt.getTime()) < 3600 * 1000;
        if (wantDebug) debug.push({ type: 'opening-check', periodId, openAt: openAt.toISOString(), now: now.toISOString(), inWindow });
        if (inWindow) {
          const windowKey = isoHourKey(openAt);
          const recips = await fetchRecipientsPlanning(periodId, wantDebug);
          totalToSend += recips.length;

          if (!dryRun) {
            const sent = await sendBulkIndividually(
              periodId, 'opening', windowKey, recips,
              () => {
                const tpl = TPL.emailOpening({
                  periodLabel: p.label,
                  openAt,
                  deadline: a.avail_deadline ? new Date(a.avail_deadline) : p.close_at,
                  siteUrl: SITE_URL,
                });
                return { subject: tpl.subject, html: tpl.html, meta: { openAt: openAt.toISOString() } };
              },
              dryRun
            );
            totalSent += sent;
          }
          if (wantDebug || dryRun) debug.push({ type: 'opening', periodId, key: windowKey, recipients: recips.map(r => r.email) });
        }
      }
    }

    // ===== B) Rappels “garde demain” (J-1) =====
    {
      const assignments = await fetchAssignmentsJ1(now);
      totalToSend += assignments.length;

      for (const a of assignments) {
        const windowKey = `slot:${a.slot_id}`;
        const already = await alreadyLogged(a.period_id, 'assignment_j1', windowKey, a.email);
        if (already) continue;

        if (!dryRun) {
          const start = new Date(a.start_ts);
          const end   = new Date(a.end_ts);
          const tpl = TPL.emailAssignmentJ1({ start, end, kind: a.kind, siteUrl: SITE_URL });
          const ok = await sendOne(a.email, tpl.subject, tpl.html);
          if (ok) {
            totalSent += 1;
            await logSent(a.period_id, 'assignment_j1', windowKey, a.email, {
              slot_id: a.slot_id, start_ts: a.start_ts, end_ts: a.end_ts
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
