// app/api/admin/email-planning/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** ---- Helpers auth ---- */
function getAccessTokenFromReq(req: NextRequest): string | null {
  // 1) Authorization: Bearer <jwt>
  const auth = req.headers.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

  // 2) Cookie direct sb-access-token (supabase-js côté client)
  const c = cookies();
  const direct = c.get('sb-access-token')?.value;
  if (direct) return direct;

  // 3) Cookie objet sb-<ref>-auth-token (Helpers) éventuellement splitté .0/.1
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
  try {
    const ref = new URL(supabaseUrl).host.split('.')[0];
    const base = `sb-${ref}-auth-token`;
    const c0 = c.get(`${base}.0`)?.value ?? '';
    const c1 = c.get(`${base}.1`)?.value ?? '';
    const cj = c.get(base)?.value ?? '';
    const raw = c0 || c1 ? `${c0}${c1}` : cj;
    if (!raw) return null;

    let txt = raw;
    try {
      txt = decodeURIComponent(raw);
    } catch {}
    const parsed = JSON.parse(txt);
    if (parsed?.access_token) return String(parsed.access_token);
    if (parsed?.currentSession?.access_token)
      return String(parsed.currentSession.access_token);
  } catch {
    // ignore
  }
  return null;
}

async function requireAdminOrResponse(req: NextRequest) {
  const supabase = getSupabaseAdmin();

  const token = getAccessTokenFromReq(req);
  if (!token) {
    return {
      errorResponse: NextResponse.json(
        { ok: false, error: 'Unauthorized' },
        { status: 401 }
      ),
      supabase,
      userId: null as string | null,
    };
  }

  const { data: userData, error: uErr } = await supabase.auth.getUser(token);
  if (uErr || !userData?.user) {
    return {
      errorResponse: NextResponse.json(
        { ok: false, error: 'Unauthorized' },
        { status: 401 }
      ),
      supabase,
      userId: null,
    };
  }

  const uid = userData.user.id;
  const { data: isAdmin, error: aErr } = await supabase.rpc('is_admin', { uid });
  if (aErr || !isAdmin) {
    return {
      errorResponse: NextResponse.json(
        { ok: false, error: 'Forbidden' },
        { status: 403 }
      ),
      supabase,
      userId: uid,
    };
  }

  return { errorResponse: null as NextResponse | null, supabase, userId: uid };
}

/** ---- Types ---- */
type AgendaRow = {
  email: string | null;
  full_name: string | null;
  display_name: string | null;
  date: string;  // 'YYYY-MM-DD'
  kind: string;  // WEEKDAY_20_00 | SAT_12_18 | ...
  period_label?: string | null;
};

/** ---- Format helpers ---- */
const KIND_TIME: Record<string, [string, string]> = {
  WEEKDAY_20_00: ['20:00', '00:00'],
  SAT_12_18: ['12:00', '18:00'],
  SAT_18_00: ['18:00', '00:00'],
  SUN_08_14: ['08:00', '14:00'],
  SUN_14_20: ['14:00', '20:00'],
  SUN_20_24: ['20:00', '00:00'],
};

function formatDateFR(ymd: string) {
  const d = new Date(`${ymd}T00:00:00`);
  const day = d.toLocaleDateString('fr-FR', { weekday: 'long' });
  const month = d.toLocaleDateString('fr-FR', { month: 'long' });
  const dd = d.getDate();
  const ddStr = dd === 1 ? '1er' : String(dd);
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return `${cap(day)} ${ddStr} ${month}`;
}
function formatKindFR(kind: string) {
  const t = KIND_TIME[kind];
  if (!t) return kind;
  const h = (s: string) => s.replace(':', 'h');
  return `${h(t[0])} - ${h(t[1])}`;
}

/** ---- Envoi email (Resend HTTP API) ---- */
async function sendWithResend({
  to,
  from,
  subject,
  html,
}: {
  to: string;
  from: string;
  subject: string;
  html: string;
}) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY missing');

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, html }),
  });

  if (!resp.ok) {
    const errTxt = await resp.text().catch(() => '');
    throw new Error(`Resend error: ${resp.status} ${errTxt}`);
  }
}

/** ---- Handler ---- */
export async function POST(req: NextRequest) {
  try {
    const { errorResponse, supabase } = await requireAdminOrResponse(req);
    if (errorResponse) return errorResponse;

    const body = await req.json().catch(() => ({}));
    const period_id = String(body?.period_id ?? '');
    if (!period_id) {
      return NextResponse.json({ error: 'period_id manquant' }, { status: 400 });
    }

    // Récupère les affectations (rows) via RPC (doit joindre emails+full_name)
    const { data: rows, error } = await supabase.rpc('get_agenda_with_emails', {
      q_period_id: period_id,
    });

    if (error) {
      return NextResponse.json(
        { error: `RPC get_agenda_with_emails: ${error.message}` },
        { status: 500 }
      );
    }

    const list = (rows ?? []) as AgendaRow[];
    if (!list.length) {
      return NextResponse.json({ ok: true, sent_count: 0, note: 'Aucune affectation' });
    }

    // Regroupe par destinataire (email)
    const byEmail = new Map<string, { name: string; items: AgendaRow[] }>();
    for (const r of list) {
      const email = (r.email || '').trim();
      if (!email) continue;
      const cur = byEmail.get(email) ?? { name: r.full_name || '', items: [] };
      cur.items.push(r);
      byEmail.set(email, cur);
    }

    const FROM_EMAIL = process.env.PLANNING_FROM_EMAIL || 'planning@mmg.example';
    const periodLabel =
      list[0]?.period_label ?? '';

    // Envoi
    let sent = 0;
    for (const [email, { name, items }] of byEmail.entries()) {
      // Tri : date, puis kind
      items.sort(
        (a, b) =>
          a.date.localeCompare(b.date) ||
          a.kind.localeCompare(b.kind)
      );

      const table = items
        .map((it) => {
          const d = formatDateFR(it.date);
          const kr = formatKindFR(it.kind);
          return `<tr><td>${d}</td><td>${kr}</td><td>${it.display_name ?? it.full_name ?? ''}</td></tr>`;
        })
        .join('');

      const html = `
        <p>Bonjour ${name || ''},</p>
        <p>Voici le planning validé de la période <strong>${periodLabel}</strong> :</p>
        <table border="1" cellpadding="6" cellspacing="0">
          <thead><tr><th>Date</th><th>Créneau</th><th>Médecin</th></tr></thead>
          <tbody>${table}</tbody>
        </table>
        <p>— Maison Médicale de Garde</p>
      `;

      await sendWithResend({
        from: FROM_EMAIL,
        to: email,
        subject: 'Planning MMG – période validée',
        html,
      });
      sent++;
    }

    return NextResponse.json({ ok: true, sent_count: sent });
  } catch (e: any) {
    console.error('email-planning error:', e);
    return NextResponse.json(
      { error: e?.message ?? 'Server error' },
      { status: 500 }
    );
  }
}
