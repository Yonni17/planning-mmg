// app/api/admin/email-test/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RESEND_API_KEY = process.env.RESEND_API_KEY!;
const FROM_EMAIL = process.env.PLANNING_FROM_EMAIL || 'planning@send.planning-mmg.ovh';

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

  try {
    const { to, template, period_id } = await req.json();
    const email = String(to || '').trim().toLowerCase();
    if (!email || !email.includes('@')) return NextResponse.json({ error: 'Email invalide' }, { status: 400 });

    let subject = '';
    let html = '';

    if (template === 'opening') {
      subject = 'Ouverture des disponibilités – MMG';
      html = `<p>Bonjour,</p><p>La saisie de vos disponibilités est <b>ouverte</b>. Merci de renseigner vos créneaux avant la date limite.</p><p><a href="${process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'}/calendrier">Accéder à la saisie</a></p>`;
    } else if (template === 'weekly') {
      subject = 'Rappel hebdo – disponibilités à saisir';
      html = `<p>Petit rappel : merci de compléter vos disponibilités si ce n’est déjà fait.</p>`;
    } else if (template === 'deadline') {
      subject = 'Dernière ligne droite – J-48/24/1h';
      html = `<p>Attention : la saisie des disponibilités se termine très bientôt.</p>`;
    } else if (template === 'planning') {
      subject = 'Planning validé – MMG';
      // Option : si tu fournis period_id, on ajoute le label
      if (period_id) {
        const { supa } = auth;
        const { data } = await supa
          .from('periods')
          .select('label')
          .eq('id', period_id)
          .maybeSingle();
        const label = data?.label ? ` (${data.label})` : '';
        subject = `Planning validé – MMG${label}`;
      }
      html = `<p>Bonjour,</p><p>Le planning a été validé. Vous pouvez le consulter ici :</p><p><a href="${process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'}/agenda">Voir le planning</a></p>`;
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
      }),
    });

    if (!res.ok) {
      const txt = await res.text();
      return NextResponse.json({ error: `Resend: ${txt}` }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 });
  }
}
