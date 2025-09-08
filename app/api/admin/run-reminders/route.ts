// app/api/admin/run-reminders/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { sendEmail } from '@/lib/email';
import { emailWeeklyReminder, emailDeadline48h, emailDeadline24h, emailDeadline1h } from '@/lib/emailTemplates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type DueKind = 'weekly' | 'deadline_48' | 'deadline_24' | 'deadline_1';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || 'https://planning-mmg.ovh';
const FROM = process.env.PLANNING_FROM_EMAIL || process.env.SMTP_FROM || 'MMG <no-reply@example.com>';

function bad(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status });
}

function getAccessTokenFromReq(req: NextRequest): string | null {
  const auth = req.headers.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const c = cookies();
  const direct = c.get('sb-access-token')?.value;
  if (direct) return direct;
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
  } catch {}
  return null;
}

async function requireAdminOrResponse(req: NextRequest) {
  const supabase = getSupabaseAdmin();
  const token = getAccessTokenFromReq(req);
  if (!token) return { errorResponse: bad(401, 'Unauthorized'), supabase };
  const { data: u, error } = await supabase.auth.getUser(token);
  if (error || !u?.user) return { errorResponse: bad(401, 'Unauthorized'), supabase };
  const { data: isAdmin, error: aErr } = await supabase.rpc('is_admin', { uid: u.user.id });
  if (aErr) return { errorResponse: bad(500, aErr.message), supabase };
  if (!isAdmin) return { errorResponse: bad(403, 'Forbidden'), supabase };
  return { supabase };
}

function computeDueKinds(now: Date, deadline: Date | null, weeklyEnabled: boolean, tz: string, extraHours: number[]): DueKind[] {
  const due: DueKind[] = [];
  if (!deadline) return due;
  if (now >= deadline) return due;
  const hoursLeft = (deadline.getTime() - now.getTime()) / 36e5;
  const tol = 0.25; // 15 min
  if (extraHours.includes(48) && Math.abs(hoursLeft - 48) <= tol) due.push('deadline_48');
  if (extraHours.includes(24) && Math.abs(hoursLeft - 24) <= tol) due.push('deadline_24');
  if (extraHours.includes(1)  && Math.abs(hoursLeft -  1) <= tol) due.push('deadline_1');

  if (weeklyEnabled) {
    const paris = new Date(now.toLocaleString('en-US', { timeZone: tz || 'Europe/Paris' }));
    const isMonday = paris.getDay() === 1;
    const isNine = paris.getHours() === 9;
    if (isMonday && isNine) due.push('weekly');
  }
  return due;
}

function dedupeKey(kind: DueKind, now: Date) {
  if (kind === 'weekly') {
    // ISO week key
    const d = new Date(now);
    const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = (tmp.getUTCDay() + 6) % 7;
    tmp.setUTCDate(tmp.getUTCDate() - day + 3);
    const firstThursday = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round(((tmp.getTime() - firstThursday.getTime()) / 86400000 - 3) / 7);
    return `W-${tmp.getUTCFullYear()}${String(week).padStart(2,'0')}`;
  }
  if (kind === 'deadline_48') return 'H-48';
  if (kind === 'deadline_24') return 'H-24';
  if (kind === 'deadline_1')  return 'H-1';
  return 'X';
}

export async function POST(req: NextRequest) {
  const auth = await requireAdminOrResponse(req);
  if ('errorResponse' in auth) return auth.errorResponse;
  const supabase = auth.supabase;

  const { period_id, nowISO, dryRun = true, forceKinds } = await req.json().catch(() => ({} as any));
  if (!period_id) return bad(400, 'period_id requis');

  const now = nowISO ? new Date(nowISO) : new Date();

  const { data: eff, error: effErr } = await supabase
    .from('v_effective_automation')
    .select('period_id,label,avail_open_at_effective,avail_deadline_effective,weekly_reminder_effective,extra_reminder_hours_effective,tz_effective')
    .eq('period_id', period_id)
    .maybeSingle();
  if (effErr || !eff) return bad(404, 'Période inconnue (v_effective_automation)');

  const openAt   = eff.avail_open_at_effective ? new Date(eff.avail_open_at_effective) : null;
  const deadline = eff.avail_deadline_effective ? new Date(eff.avail_deadline_effective) : null;
  const inWindow = !!(openAt && deadline && now >= openAt && now < deadline);

  const extra = Array.isArray(eff.extra_reminder_hours_effective) ? eff.extra_reminder_hours_effective as number[] : [];
  let due: DueKind[] = [];
  if (forceKinds && Array.isArray(forceKinds) && forceKinds.length) {
    due = forceKinds.filter((k: any): k is DueKind => ['weekly','deadline_48','deadline_24','deadline_1'].includes(k));
  } else if (inWindow) {
    due = computeDueKinds(now, deadline, !!eff.weekly_reminder_effective, eff.tz_effective || 'Europe/Paris', extra);
  }

  const { data: targets, error: tErr } = await supabase
    .from('v_reminder_targets')
    .select('user_id')
    .eq('period_id', period_id);
  if (tErr) return bad(500, tErr.message);

  const ids = (targets || []).map(t => t.user_id);
  if (!ids.length) {
    return NextResponse.json({ ok: true, info: 'Aucun destinataire', due_kinds: due, sent: 0, dryRun });
  }

  const { data: profs } = await supabase
    .from('profiles')
    .select('user_id,email,full_name')
    .in('user_id', ids);
  const recipients = (profs || []).filter(p => !!p.email);

  const logs: any[] = [];
  const errors: any[] = [];
  let sendCount = 0;

  for (const kind of due) {
    const key = dedupeKey(kind, now);
    for (const r of recipients) {
      const logRow = { period_id, user_id: r.user_id, kind, dedupe_key: key };
      const { error: logErr } = await supabase.from('email_sent_log').insert(logRow);
      if (logErr) {
        if (!/duplicate key value/.test(logErr.message) && !/relation .* does not exist/.test(logErr.message)) {
          errors.push({ user_id: r.user_id, email: r.email, error: logErr.message });
        }
        continue;
      }
      if (dryRun) { logs.push({ kind, email: r.email, name: r.full_name, dedupe: key }); continue; }

      try {
        let subject = '', html = '', text = '';
        const ctx = { periodLabel: eff.label as string | undefined, deadline: deadline ?? null, siteUrl: SITE_URL };
        if (kind === 'weekly') {
          const t = emailWeeklyReminder({ periodLabel: ctx.periodLabel, deadline: ctx.deadline, siteUrl: SITE_URL });
          subject = t.subject; html = t.html; text = t.text;
        } else if (kind === 'deadline_48') {
          const t = emailDeadline48h({ periodLabel: ctx.periodLabel, deadline: ctx.deadline, siteUrl: SITE_URL });
          subject = t.subject; html = t.html; text = t.text;
        } else if (kind === 'deadline_24') {
          const t = emailDeadline24h({ periodLabel: ctx.periodLabel, deadline: ctx.deadline, siteUrl: SITE_URL });
          subject = t.subject; html = t.html; text = t.text;
        } else if (kind === 'deadline_1') {
          const t = emailDeadline1h({ periodLabel: ctx.periodLabel, deadline: ctx.deadline, siteUrl: SITE_URL });
          subject = t.subject; html = t.html; text = t.text;
        }
        await sendEmail({ to: r.email!, subject, html, text, fromOverride: FROM });
        sendCount++;
        logs.push({ kind, email: r.email, name: r.full_name, dedupe: key, sent: true });
      } catch (e: any) {
        errors.push({ user_id: r.user_id, email: r.email, error: e?.message || String(e) });
      }
    }
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    due_kinds: due,
    recipients: recipients.length,
    attempted: logs.length,
    sent: dryRun ? 0 : sendCount,
    errors,
    sample: logs.slice(0, 20),
  });
}
