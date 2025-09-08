import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { subject, bodyOpening, bodyWeekly, bodyDeadline, bodyPlanningReady } from '@/lib/emails/templates';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const FROM = process.env.PLANNING_FROM_EMAIL!;

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

  // Infos de période (label + deadline effective pour affichage)
  let periodLabel: string | undefined = undefined;
  let deadline: string | undefined = undefined;
  if (period_id) {
    const { data: eff } = await service
      .from('v_effective_automation')
      .select('period_id,label,avail_deadline_effective')
      .eq('period_id', period_id)
      .maybeSingle();
    periodLabel = eff?.label || undefined;
    deadline = eff?.avail_deadline_effective || undefined;
  }

  const subj = subject(template, periodLabel);
  let html: string;
  switch (template) {
    case 'opening':
      html = bodyOpening(periodLabel, undefined, deadline);
      break;
    case 'weekly':
      html = bodyWeekly(periodLabel, deadline);
      break;
    case 'deadline_48':
    case 'deadline_24':
    case 'deadline_1':
      html = bodyDeadline(template, periodLabel, deadline);
      break;
    case 'planning_ready':
      html = bodyPlanningReady(periodLabel);
      break;
    default:
      return bad(400, 'Unknown template');
  }

  // Envoi: au choix Resend ou SMTP. Exemple générique via nodemailer (SMTP):
  // (si tu utilises Resend, remplace par leur SDK)
  try {
    // @ts-ignore pseudo-fonction à brancher sur ton transport
    await sendMail({ from: FROM, to, subject: subj, html });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return bad(500, e.message || 'send error');
  }
}
