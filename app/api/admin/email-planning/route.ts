// app/api/admin/email-planning/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { Resend } from 'resend';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------- Auth helpers (reutilisés) ----------
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
  if (!token) {
    return { errorResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }), supabase, userId: null as string | null };
  }
  const { data: userData, error: uErr } = await supabase.auth.getUser(token);
  if (uErr || !userData?.user) {
    return { errorResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }), supabase, userId: null };
  }
  const uid = userData.user.id;
  const { data: isAdmin, error: aErr } = await supabase.rpc('is_admin', { uid });
  if (aErr || !isAdmin) {
    return { errorResponse: NextResponse.json({ error: 'Forbidden' }, { status: 403 }), supabase, userId: uid };
  }
  return { errorResponse: null as NextResponse | null, supabase, userId: uid };
}
// ------------------------------------------------

type AssignRow = {
  slot_id: string;
  user_id: string | null;
  date: string;
  kind: string;
  start_ts: string;
  period_id: string;
  email: string | null;
  full_name: string | null;
};

const KIND_LABEL: Record<string, string> = {
  WEEKDAY_20_00: '20:00–00:00',
  SAT_12_18: '12:00–18:00',
  SAT_18_00: '18:00–00:00',
  SUN_08_14: '08:00–14:00',
  SUN_14_20: '14:00–20:00',
  SUN_20_24: '20:00–00:00',
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

const SLEEP = (ms: number) => new Promise(res => setTimeout(res, ms));

async function sendWithThrottle(
  resend: Resend,
  payloads: { to: string; subject: string; html: string }[],
  perRequestDelayMs = 600,
  maxRetries = 3,
) {
  const results: { ok: boolean; to: string; error?: string }[] = [];

  for (const p of payloads) {
    let attempt = 0;
    // throttle: 2 req/s => ~600ms d’intervalle
    if (perRequestDelayMs > 0) await SLEEP(perRequestDelayMs);

    while (true) {
      try {
        const r = await resend.emails.send({
          from: process.env.EMAIL_FROM || 'planning@mmg.local',
          to: p.to,
          subject: p.subject,
          html: p.html,
        });
        if ((r as any)?.error) {
          throw new Error((r as any).error?.message ?? 'send failed');
        }
        results.push({ ok: true, to: p.to });
        break;
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        const is429 = /rate_limit|429/i.test(msg);
        const is5xx = /5\d\d/.test(msg) || /ECONNRESET|ETIMEDOUT/i.test(msg);
        if ((is429 || is5xx) && attempt < maxRetries) {
          // backoff exponentiel simple
          const wait = Math.min(4000, 600 * Math.pow(2, attempt));
          await SLEEP(wait);
          attempt++;
          continue;
        }
        results.push({ ok: false, to: p.to, error: msg });
        break;
      }
    }
  }
  return results;
}

export async function POST(req: NextRequest) {
  try {
    const { errorResponse, supabase } = await requireAdminOrResponse(req);
    if (errorResponse) return errorResponse;

    const { period_id }: { period_id?: string } = await req.json().catch(() => ({}));
    if (!period_id) return NextResponse.json({ error: 'period_id requis' }, { status: 400 });

    // Récup info période (label)
    const { data: pData, error: pErr } = await supabase
      .from('periods')
      .select('id,label')
      .eq('id', period_id)
      .maybeSingle();
    if (pErr || !pData) return NextResponse.json({ error: 'Période introuvable' }, { status: 404 });

    // Récup des assignations + slots + email profile
    const { data: rows, error: aErr } = await supabase
      .from('assignments')
      .select(`
        slot_id,
        user_id,
        period_id,
        score,
        slots!inner(id, date, kind, start_ts),
        profiles!assignments_user_id_fkey(user_id, email, first_name, last_name, full_name)
      `)
      .eq('period_id', period_id);

    if (aErr) throw aErr;

    // Aplatir
    const flat: AssignRow[] = (rows ?? []).map((r: any) => ({
      slot_id: r.slot_id,
      user_id: r.user_id,
      date: r.slots?.date,
      kind: r.slots?.kind,
      start_ts: r.slots?.start_ts,
      period_id: r.period_id,
      email: r.profiles?.email ?? null,
      full_name:
        r.profiles?.full_name ??
        [r.profiles?.first_name, r.profiles?.last_name].filter(Boolean).join(' ') ||
        null,
    }));

    // Grouper par user (email obligatoire)
    const byUser = new Map<
      string,
      { name: string; email: string; items: { date: string; kind: string }[] }
    >();

    for (const r of flat) {
      if (!r.user_id || !r.email) continue;
      if (!byUser.has(r.user_id)) {
        byUser.set(r.user_id, { name: r.full_name || r.email, email: r.email, items: [] });
      }
      byUser.get(r.user_id)!.items.push({ date: r.date, kind: r.kind });
    }

    // Si aucune assignation utilisable
    if (byUser.size === 0) {
      return NextResponse.json({ error: 'Aucune assignation avec email disponible' }, { status: 400 });
    }

    // Construire payloads
    const subject = `Planning ${pData.label} – MMG`;
    const payloads = Array.from(byUser.values()).map(({ name, email, items }) => {
      // Tableau HTML simple
      const rows = items
        .sort((a, b) => String(a.date).localeCompare(String(b.date)))
        .map(
          (i) =>
            `<tr>
               <td style="padding:6px 8px;border:1px solid #e5e7eb;">${formatDateFR(i.date)}</td>
               <td style="padding:6px 8px;border:1px solid #e5e7eb;">${KIND_LABEL[i.kind] ?? i.kind}</td>
             </tr>`
        )
        .join('');

      const html = `
        <div style="font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial;">
          <h2 style="margin:0 0 8px 0;">Bonjour ${name || ''},</h2>
          <p style="margin:0 0 12px 0;">Voici vos gardes pour <strong>${pData.label}</strong> :</p>
          <table cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #e5e7eb;">
            <thead>
              <tr style="background:#f9fafb;">
                <th align="left" style="padding:6px 8px;border:1px solid #e5e7eb;">Date</th>
                <th align="left" style="padding:6px 8px;border:1px solid #e5e7eb;">Créneau</th>
              </tr>
            </thead>
            <tbody>${rows || `<tr><td colspan="2" style="padding:8px;">Aucune garde assignée</td></tr>`}</tbody>
          </table>
          <p style="color:#6b7280;margin-top:12px;">Cet email a été envoyé automatiquement. En cas d’erreur, merci de contacter l’administrateur.</p>
        </div>
      `;

      return { to: email, subject, html };
    });

    // Envoi avec throttling + retry
    const resend = new Resend(process.env.RESEND_API_KEY!);
    const results = await sendWithThrottle(resend, payloads, 650, 3);

    const sent = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok);

    return NextResponse.json({
      period_id,
      sent_count: sent,
      failed_count: failed.length,
      failed,
    });
  } catch (e: any) {
    console.error('[email-planning]', e);
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 });
  }
}
