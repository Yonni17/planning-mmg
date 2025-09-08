// app/api/admin/emails/send/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { sendEmail } from '@/lib/email';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type TemplateId =
  | 'opening'           // ouverture des dispos
  | 'weekly'            // rappel hebdo
  | 'deadline_48'       // rappel J-2
  | 'deadline_24'       // rappel J-1
  | 'deadline_1'        // rappel H-1
  | 'planning_ready'    // planning validé
  | 'assignment_j7'     // rappel affectation J-7
  | 'assignment_j1';    // rappel affectation J-1

function requireBearer(req: NextRequest) {
  const h = req.headers.get('authorization') || '';
  if (!h.toLowerCase().startsWith('bearer ')) return null;
  return h.slice(7).trim();
}

async function assertAdmin(req: NextRequest) {
  const supabase = getSupabaseAdmin();
  const token = requireBearer(req);
  if (!token) return { error: 'Unauthorized', status: 401 as const };

  const { data: u, error } = await supabase.auth.getUser(token);
  if (error || !u?.user) return { error: 'Unauthorized', status: 401 as const };

  const { data: isAdmin, error: aErr } = await supabase.rpc('is_admin', { uid: u.user.id });
  if (aErr) return { error: aErr.message, status: 500 as const };
  if (!isAdmin) return { error: 'Forbidden', status: 403 as const };
  return { supabase, user: u.user };
}

function renderTemplate(tpl: TemplateId, params: { periodLabel?: string; agendaUrl?: string }) {
  const period = params.periodLabel || 'Période en cours';
  const agenda = params.agendaUrl || '#';

  switch (tpl) {
    case 'opening':
      return {
        subject: `Ouverture des disponibilités — ${period}`,
        html: `<p>Bonjour,</p><p>La saisie des disponibilités est ouverte pour <b>${period}</b>.</p><p>Merci de renseigner vos créneaux dès que possible.</p>`,
      };
    case 'weekly':
      return {
        subject: `Rappel hebdomadaire — disponibilités ${period}`,
        html: `<p>Petit rappel : merci de compléter vos disponibilités pour <b>${period}</b>.</p>`,
      };
    case 'deadline_48':
      return {
        subject: `J-2 — fermeture des disponibilités (${period})`,
        html: `<p>Plus que 48h pour compléter vos disponibilités pour <b>${period}</b>.</p>`,
      };
    case 'deadline_24':
      return {
        subject: `J-1 — fermeture des disponibilités (${period})`,
        html: `<p>Plus que 24h pour compléter vos disponibilités pour <b>${period}</b>.</p>`,
      };
    case 'deadline_1':
      return {
        subject: `H-1 — fermeture des disponibilités (${period})`,
        html: `<p>Dernier rappel : la saisie ferme dans 1h pour <b>${period}</b>.</p>`,
      };
    case 'planning_ready':
      return {
        subject: `Planning validé — ${period}`,
        html: `<p>Le planning pour <b>${period}</b> est validé.</p><p>Consultez l’agenda : <a href="${agenda}">${agenda}</a></p>`,
      };
    case 'assignment_j7':
      return {
        subject: `Rappel garde — J-7`,
        html: `<p>Rappel : vous avez une garde dans 7 jours.</p>`,
      };
    case 'assignment_j1':
      return {
        subject: `Rappel garde — J-1`,
        html: `<p>Rappel : vous avez une garde demain.</p>`,
      };
    default:
      return null;
  }
}

export async function POST(req: NextRequest) {
  const auth = await assertAdmin(req);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const to = String(body?.to || '').trim().toLowerCase();
    const template = String(body?.template || '') as TemplateId;
    const periodLabel = String(body?.period_label || 'T4 2025');
    const agendaUrl = String(body?.agenda_url || `${process.env.NEXT_PUBLIC_SITE_URL || ''}/agenda`);

    if (!to || !to.includes('@')) {
      return NextResponse.json({ error: 'Email invalide' }, { status: 400 });
    }

    const payload = renderTemplate(template, { periodLabel, agendaUrl });
    if (!payload) {
      return NextResponse.json({ error: 'Template inconnu' }, { status: 400 });
    }

    await sendEmail({
      to,
      subject: payload.subject,
      html: payload.html,
    });

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 });
  }
}