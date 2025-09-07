import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { sendEmail } from '@/lib/email';
import { emailPlanningReady } from '@/lib/emailTemplates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Augmente la durée max si beaucoup de destinataires (Vercel / Node.js)
export const maxDuration = 300;

/* -------------------- Helpers auth (Bearer / Cookies) -------------------- */
function getAccessTokenFromReq(req: NextRequest): string | null {
  const auth = req.headers.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

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
  if (!token) {
    return {
      errorResponse: NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 }),
      supabase,
      userId: null as string | null,
    };
  }
  const { data: userData, error: uErr } = await supabase.auth.getUser(token);
  if (uErr || !userData?.user) {
    return {
      errorResponse: NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 }),
      supabase,
      userId: null as string | null,
    };
  }
  const uid = userData.user.id;
  const { data: isAdmin, error: aErr } = await supabase.rpc('is_admin', { uid });
  if (aErr || !isAdmin) {
    return {
      errorResponse: NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 }),
      supabase,
      userId: uid,
    };
  }
  return { errorResponse: null as NextResponse | null, supabase, userId: uid };
}

/* ------------------------ Utils format ------------------------ */
type SlotKind =
  | 'WEEKDAY_20_00'
  | 'SAT_12_18'
  | 'SAT_18_00'
  | 'SUN_08_14'
  | 'SUN_14_20'
  | 'SUN_20_24';

const KIND_TIME: Record<SlotKind, [string, string]> = {
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
function formatKindFR(kind: SlotKind) {
  const t = KIND_TIME[kind];
  const h = (s: string) => s.replace(':', 'h');
  return `${h(t[0])} - ${h(t[1])}`;
}

/* ------------------------ Types data ------------------------ */
type AgendaRow = {
  period_id: string;
  period_label: string | null;
  date: string;       // YYYY-MM-DD
  kind: SlotKind;
  display_name: string | null;
  email: string | null;
  full_name: string | null;
};

/* ------------------------ Throttle & Retry ------------------------ */

// Respect strictement 2 req/s → on vise 1.4–1.6 req/s
const MIN_GAP_MS = Number(process.env.EMAIL_MIN_GAP_MS ?? 650); // 650ms entre envois
const MAX_RETRIES = 5;

// backoff exponentiel (avec jitter) quand 429
function backoffDelay(attempt: number) {
  const base = Math.min(1000 * Math.pow(2, attempt), 8000); // 1s, 2s, 4s, 8s (cap)
  const jitter = Math.floor(Math.random() * 250); // +0–250ms
  return base + jitter;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------ Handler ------------------------ */
export async function POST(req: NextRequest) {
  const admin = await requireAdminOrResponse(req);
  if (admin.errorResponse) return admin.errorResponse;
  const supabase = admin.supabase;

  try {
    const { period_id } = (await req.json()) as { period_id?: string };
    if (!period_id) {
      return NextResponse.json({ ok: false, error: 'period_id requis' }, { status: 400 });
    }

    // Période (label)
    const { data: period, error: perr } = await supabase
      .from('periods')
      .select('id,label')
      .eq('id', period_id)
      .maybeSingle();
    if (perr || !period) {
      return NextResponse.json({ ok: false, error: `Période introuvable` }, { status: 404 });
    }
    const periodLabel: string = period.label;

    // Agenda + emails (RPC existante)
    const { data: rows, error } = await supabase.rpc('get_agenda_with_emails', {
      q_period_id: period_id,
    });
    if (error) {
      return NextResponse.json(
        { ok: false, error: `RPC get_agenda_with_emails: ${error.message}` },
        { status: 500 }
      );
    }

    const list = (rows ?? []) as AgendaRow[];
    if (!list.length) {
      return NextResponse.json({ ok: true, sent_count: 0, note: 'Aucune affectation' });
    }

    // Group by email
    const byEmail = new Map<string, { name: string; items: AgendaRow[] }>();
    for (const r of list) {
      const email = (r.email || '').trim();
      if (!email) continue;
      const cur = byEmail.get(email) ?? { name: (r.full_name || '').trim(), items: [] };
      cur.items.push(r);
      byEmail.set(email, cur);
    }

    const siteUrl =
      process.env.NEXT_PUBLIC_SITE_URL ||
      process.env.SITE_URL ||
      process.env.VERCEL_PROJECT_PRODUCTION_URL ||
      '';

    const FROM_EMAIL =
      process.env.PLANNING_FROM_EMAIL ||
      process.env.SMTP_FROM ||
      'planning@mmg.example';

    const recipients = Array.from(byEmail.entries()); // [email, { name, items }]
    let sent = 0;

    // On envoie **strictement en série** avec un interstice MIN_GAP_MS entre chaque requête,
    // et un retry exponentiel en cas de 429. Ainsi, on ne dépassera jamais 2 req/s.
    let lastSentAt = 0;

    for (const [email, { name, items }] of recipients) {
      // Trie pour un rendu propre
      items.sort(
        (a, b) =>
          a.date.localeCompare(b.date) ||
          a.kind.localeCompare(b.kind)
      );

      const rowsHtml = items.map((it) => {
        const d = formatDateFR(it.date);
        const kr = formatKindFR(it.kind);
        const who = (it.display_name ?? it.full_name ?? '').toString();
        return `<tr>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;">${d}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;">${kr}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;">${who}</td>
        </tr>`;
      }).join('');

      const { subject, html, text } = emailPlanningReady({
        name,
        periodLabel,
        siteUrl: siteUrl || '',
      });

      const htmlWithTable = html.replace(
        '</p>\n    <p>Le planning',
        `</p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:8px 0 16px 0;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
      <thead>
        <tr style="background:#f3f4f6">
          <th align="left" style="padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;">Date</th>
          <th align="left" style="padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;">Créneau</th>
          <th align="left" style="padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;">Médecin</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>
    <p>Le planning`
      );

      // throttling : assure MIN_GAP_MS entre deux requêtes
      const now = Date.now();
      const diff = now - lastSentAt;
      if (lastSentAt > 0 && diff < MIN_GAP_MS) {
        await sleep(MIN_GAP_MS - diff);
      }

      let ok = false;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          await sendEmail({
            to: email,
            subject,
            html: htmlWithTable,
            text,
            fromOverride: FROM_EMAIL,
          });
          ok = true;
          break;
        } catch (err: any) {
          const msg = String(err?.message || '');
          const is429 = msg.startsWith('429'); // lib/email.ts préfixe "429: ..."
          if (is429 && attempt < MAX_RETRIES) {
            const wait = backoffDelay(attempt); // 1s → 2s → 4s → 8s (cap)
            await sleep(wait);
            continue;
          }
          // autres erreurs : on log et on continue
          console.warn('[email-planning] Échec d’envoi à', email, msg);
          break;
        }
      }

      lastSentAt = Date.now(); // pour le calcul du prochain gap

      if (ok) sent++;
    }

    return NextResponse.json({ ok: true, sent_count: sent });
  } catch (e: any) {
    console.error('email-planning error:', e);
    return NextResponse.json(
      { ok: false, error: e?.message ?? 'Server error' },
      { status: 500 }
    );
  }
}
