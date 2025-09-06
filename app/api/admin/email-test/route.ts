// app/api/admin/email-test/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import {
  emailOpening,
  emailWeeklyReminder,
  emailDeadline,
  emailPlanningReady,
} from '@/lib/emailTemplates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.PLANNING_FROM_EMAIL || 'planning@send.planning-mmg.ovh';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';

function getBearer(req: NextRequest) {
  const h = req.headers.get('authorization') || '';
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  return null;
}

async function requireAdmin(req: NextRequest) {
  const token = getBearer(req);
  if (!token) return { error: 'Unauthorized' as const };
  const supa = getSupabaseAdmin();
  const { data: u, error } = await supa.auth.getUser(token);
  if (error || !u?.user) return { error: 'Unauthorized' as const };
  const { data: isAdmin, error: aErr } = await supa.rpc('is_admin', { uid: u.user.id });
  if (aErr || !isAdmin) return { error: 'Forbidden' as const };
  return { supa };
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: 401 });

  if (!RESEND_API_KEY) {
    return NextResponse.json({ error: 'RESEND_API_KEY manquant' }, { status: 500 });
  }

  try {
    const { to, template, period_id, name, hoursBefore } = await req.json();
    const email = String(to || '').trim().toLowerCase();
    if (!email || !email.includes('@')) return NextResponse.json({ error: 'Email invalide' }, { status: 400 });

    // Récupère infos période/automation si besoin
    let periodLabel: string | undefined;
    let openAt: Date | null = null;
    let deadline: Date | null = null;

    if (period_id) {
      const { supa } = auth;
      const { data: p } = await supa.from('periods').select('label').eq('id', period_id).maybeSingle();
      periodLabel = p?.label || undefined;

      const { data: auto } = await supa
        .from('period_automation')
        .select('avail_open_at, avail_deadline')
        .eq('period_id', period_id)
        .maybeSingle();
      openAt = auto?.avail_open_at ? new Date(auto.avail_open_at) : null;
      deadline = auto?.avail_deadline ? new Date(auto.avail_deadline) : null;
    }

    // Construit le contenu selon le template
    let subject = '';
    let html = '';
    let text = '';

    if (template === 'opening') {
      ({ subject, html, text } = emailOpening({ name, periodLabel, openAt, deadline, siteUrl: SITE_URL }));
    } else if (template === 'weekly') {
      ({ subject, html, text } = emailWeeklyReminder({ name, periodLabel, deadline, siteUrl: SITE_URL }));
    } else if (template === 'deadline') {
      const hb = Number.isFinite(hoursBefore) ? Number(hoursBefore) : null;
      ({ subject, html, text } = emailDeadline({ name, periodLabel, deadline, hoursBefore: hb, siteUrl: SITE_URL }));
    } else if (template === 'planning') {
      ({ subject, html, text } = emailPlanningReady({ name, periodLabel, siteUrl: SITE_URL }));
    } else {
      return NextResponse.json({ error: 'template inconnu' }, { status: 400 });
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: email,
        subject,
        html,
        text,
        // reply_to: 'support@...' // si tu veux centraliser les réponses
      }),
    });

    if (!res.ok) {
      const txt = await res.text();
      return NextResponse.json({ error: `Resend: ${txt}` }, { status: 500 });
    }

    return NextResponse.json({ ok: true, subject });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 });
  }
}
