// app/api/admin/email-test/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  emailOpening,
  emailWeeklyReminder,
  emailDeadline48h,
  emailDeadline24h,
  emailDeadline1h,
  emailPlanningReady,
} from '@/lib/emailTemplates'; // <-- corrige l'import

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const FROM = process.env.PLANNING_FROM_EMAIL!;
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || 'https://planning-mmg.ovh';

function bad(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

async function requireAdmin(req: NextRequest) {
  const authHeader = req.headers.get('authorization') || '';
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: u } = await anon.auth.getUser();
  if (!u?.user) return { ok: false as const, error: 'Unauthenticated' };

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: prof } = await service.from('profiles').select('role').eq('user_id', u.user.id).maybeSingle();
  if (!prof || prof.role !== 'admin') return { ok: false as const, error: 'Forbidden' };
  return { ok: true as const };
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return bad(401, admin.error);

  const { to, template, period_id } = await req.json();
  if (!to || !template) return bad(400, 'Missing to/template');

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // Récupère label + deadline effective pour afficher dans les mails
  let periodLabel: string | undefined;
  let deadlineDate: Date | null = null;

  if (period_id) {
    const { data: eff, error } = await service
      .from('v_effective_automation')
      .select('label, avail_deadline_effective')
      .eq('period_id', period_id)
      .maybeSingle();
    if (error) return bad(500, error.message);
    periodLabel = eff?.label || undefined;
    deadlineDate = eff?.avail_deadline_effective ? new Date(eff.avail_deadline_effective) : null;
  }

  // Construit le mail selon le template demandé
  let subject: string, html: string, text?: string;

  switch (template as string) {
    case 'opening': {
      const res = emailOpening({ periodLabel, openAt: null, deadline: deadlineDate, siteUrl: SITE_URL });
      subject = res.subject; html = res.html; text = res.text; break;
    }
    case 'weekly': {
      const res = emailWeeklyReminder({ periodLabel, deadline: deadlineDate, siteUrl: SITE_URL });
      subject = res.subject; html = res.html; text = res.text; break;
    }
    case 'deadline_48': {
      const res = emailDeadline48h({ periodLabel, deadline: deadlineDate, siteUrl: SITE_URL });
      subject = res.subject; html = res.html; text = res.text; break;
    }
    case 'deadline_24': {
      const res = emailDeadline24h({ periodLabel, deadline: deadlineDate, siteUrl: SITE_URL });
      subject = res.subject; html = res.html; text = res.text; break;
    }
    case 'deadline_1': {
      const res = emailDeadline1h({ periodLabel, deadline: deadlineDate, siteUrl: SITE_URL });
      subject = res.subject; html = res.html; text = res.text; break;
    }
    case 'planning_ready': {
      const res = emailPlanningReady({ periodLabel, siteUrl: SITE_URL });
      subject = res.subject; html = res.html; text = res.text; break;
    }
    default:
      return bad(400, 'Unknown template');
  }

  try {
    // Branche sur ton transport (Resend ou SMTP). Exemples:
    // await resend.emails.send({ from: FROM, to, subject, html });
    // ou
    // await smtpTransport.sendMail({ from: FROM, to, subject, html, text });
    // @ts-ignore
    await sendMail({ from: FROM, to, subject, html, text });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return bad(500, e.message || 'send error');
  }
}
