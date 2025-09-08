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
} from '@/lib/emailTemplates';

// Si tu as un transport centralisé, remplace cette ligne par:
// import { sendEmail } from '@/lib/email';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const FROM = process.env.PLANNING_FROM_EMAIL || process.env.SMTP_FROM || 'MMG <no-reply@example.com>';
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

// ---- Normalisation des alias de template ----
type Canonical =
  | 'opening'
  | 'weekly'
  | 'deadline_48'
  | 'deadline_24'
  | 'deadline_1'
  | 'planning_ready';

function normalizeTemplate(input: string | undefined | null): Canonical | null {
  if (!input) return null;
  const t = input.toString().trim().toLowerCase();

  if (['opening', 'ouverture'].includes(t)) return 'opening';
  if (['weekly', 'hebdo', 'rappel', 'rappel_hebdo', 'rappel-hebdo'].includes(t)) return 'weekly';
  if (['deadline_48', 'deadline-48', '48', '48h', '-48h', 'j-2', 'h-48', 'd-48', 'fin-48'].includes(t)) return 'deadline_48';
  if (['deadline_24', 'deadline-24', '24', '24h', '-24h', 'j-1', 'h-24', 'd-24', 'fin-24'].includes(t)) return 'deadline_24';
  if (['deadline_1', 'deadline-1', '1', '1h', '-1h', 'h-1', 'fin-1'].includes(t)) return 'deadline_1';
  if (['planning_ready', 'planning', 'planning-prep'].includes(t)) return 'planning_ready';

  return null;
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return bad(401, admin.error);

  const { to, template, period_id } = await req.json();
  if (!to) return bad(400, 'Missing "to"');

  const canonical = normalizeTemplate(template);
  if (!canonical) return bad(400, 'template inconnu');

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // Récupère label + deadline effective pour les mails "deadline_xx"
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

  let subject = '', html = '', text: string | undefined;

  switch (canonical) {
    case 'opening': {
      const t = emailOpening({ periodLabel, openAt: null, deadline: deadlineDate, siteUrl: SITE_URL });
      subject = t.subject; html = t.html; text = t.text; break;
    }
    case 'weekly': {
      const t = emailWeeklyReminder({ periodLabel, deadline: deadlineDate, siteUrl: SITE_URL });
      subject = t.subject; html = t.html; text = t.text; break;
    }
    case 'deadline_48': {
      const t = emailDeadline48h({ periodLabel, deadline: deadlineDate, siteUrl: SITE_URL });
      subject = t.subject; html = t.html; text = t.text; break;
    }
    case 'deadline_24': {
      const t = emailDeadline24h({ periodLabel, deadline: deadlineDate, siteUrl: SITE_URL });
      subject = t.subject; html = t.html; text = t.text; break;
    }
    case 'deadline_1': {
      const t = emailDeadline1h({ periodLabel, deadline: deadlineDate, siteUrl: SITE_URL });
      subject = t.subject; html = t.html; text = t.text; break;
    }
    case 'planning_ready': {
      const t = emailPlanningReady({ periodLabel, siteUrl: SITE_URL });
      subject = t.subject; html = t.html; text = t.text; break;
    }
  }

  try {
    // Si tu as un transport unifié:
    // await sendEmail({ to, subject, html, text, fromOverride: FROM });

    // Sinon garde ton "placeholder" historique:
    // @ts-ignore
    await sendMail({ from: FROM, to, subject, html, text });
    return NextResponse.json({ ok: true, template: canonical });
  } catch (e: any) {
    return bad(500, e.message || 'send error');
  }
}
