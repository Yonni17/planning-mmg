// app/api/admin/email-test/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL =
  process.env.PLANNING_FROM_EMAIL || 'MMG <planning@send.planning-mmg.ovh>';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';

function getBearer(req: NextRequest) {
  const h = req.headers.get('authorization') || '';
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : null;
}

async function requireAdmin(req: NextRequest) {
  const token = getBearer(req);
  if (!token) return { error: 'Unauthorized' as const };

  const supa = getSupabaseAdmin();
  const { data: u, error } = await supa.auth.getUser(token);
  if (error || !u?.user) return { error: 'Unauthorized' as const };

  const { data: isAdmin, error: aErr } = await supa.rpc('is_admin', {
    uid: u.user.id,
  });
  if (aErr || !isAdmin) return { error: 'Forbidden' as const };

  return { supa };
}

export async function POST(req: NextRequest) {
  // sécurité admin
  const auth = await requireAdmin(req);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  if (!RESEND_API_KEY) {
    return NextResponse.json(
      { error: 'RESEND_API_KEY manquant dans les variables d’environnement' },
      { status: 500 }
    );
  }

  try {
    const { to, template, period_id, subject: subjOverride, html: htmlOverride, text: textOverride } =
      await req.json();

    const email = String(to || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      return NextResponse.json({ error: 'Email invalide' }, { status: 400 });
    }

    // contenu par template
    let subject = '';
    let html = '';
    let text = '';

    if (htmlOverride || textOverride || subjOverride) {
      subject = subjOverride || 'Test email – Planning MMG';
      html = htmlOverride || '<p>Bonjour 👋<br/>Ceci est un test.</p>';
      text = textOverride || 'Bonjour, ceci est un test.';
    } else if (template === 'opening') {
      subject = 'Ouverture des disponibilités – MMG';
      html = `<p>Bonjour,</p>
              <p>La saisie de vos disponibilités est <b>ouverte</b>. Merci de renseigner vos créneaux avant la date limite.</p>
              <p><a href="${SITE_URL}/calendrier">Accéder à la saisie</a></p>`;
      text = `Bonjour,
La saisie de vos disponibilités est ouverte. Merci de renseigner vos créneaux avant la date limite.
Accéder à la saisie : ${SITE_URL}/calendrier`;
    } else if (template === 'weekly') {
      subject = 'Rappel hebdo – disponibilités à saisir';
      html = `<p>Petit rappel : merci de compléter vos disponibilités si ce n’est déjà fait.</p>
              <p><a href="${SITE_URL}/calendrier">Accéder à la saisie</a></p>`;
      text = `Petit rappel : merci de compléter vos disponibilités si ce n’est déjà fait.
Accéder à la saisie : ${SITE_URL}/calendrier`;
    } else if (template === 'deadline') {
      subject = 'Dernière ligne droite – J-48/24/1h';
      html = `<p>Attention : la saisie des disponibilités se termine très bientôt.</p>
              <p><a href="${SITE_URL}/calendrier">Accéder à la saisie</a></p>`;
      text = `Attention : la saisie des disponibilités se termine très bientôt.
Accéder à la saisie : ${SITE_URL}/calendrier`;
    } else if (template === 'planning') {
      let label = '';
      if (period_id) {
        const { supa } = auth;
        const { data } = await supa
          .from('periods')
          .select('label')
          .eq('id', period_id)
          .maybeSingle();
        if (data?.label) label = ` (${data.label})`;
      }
      subject = `Planning validé – MMG${label}`;
      html = `<p>Bonjour,</p>
              <p>Le planning a été validé. Vous pouvez le consulter ici :</p>
              <p><a href="${SITE_URL}/agenda">Voir le planning</a></p>`;
      text = `Bonjour,
Le planning a été validé. Vous pouvez le consulter ici :
${SITE_URL}/agenda`;
    } else {
      return NextResponse.json({ error: 'template inconnu' }, { status: 400 });
    }

    // envoi via Resend
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
      }),
    });

    if (!res.ok) {
      let msg = `Resend: ${res.status}`;
      try {
        const j = await res.json();
        if (j?.name || j?.message) {
          msg += ` ${j.name ?? ''} ${j.message ?? ''}`.trim();
        }
      } catch {
        const t = await res.text().catch(() => '');
        if (t) msg += ` ${t}`;
      }
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 });
  }
}
