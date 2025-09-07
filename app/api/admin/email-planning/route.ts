// app/api/admin/email-planning/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { sendEmail } from '@/lib/email';
import { emailPlanningReady } from '@/lib/emailTemplates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* -------------------- Helpers auth (Bearer / Cookies) -------------------- */
function getAccessTokenFromReq(req: NextRequest): string | null {
  // 1) Authorization: Bearer <jwt>
  const auth = req.headers.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

  // 2) Cookie sb-access-token (Supabase helpers)
  const c = cookies();
  const direct = c.get('sb-access-token')?.value;
  if (direct) return direct;

  // 3) Cookie objet sb-<ref>-auth-token .0/.1 ou complet
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

    // Récupérer la période (label)
    const { data: period, error: perr } = await supabase
      .from('periods')
      .select('id,label')
      .eq('id', period_id)
      .maybeSingle();
    if (perr || !period) {
      return NextResponse.json({ ok: false, error: `Période introuvable` }, { status: 404 });
    }
    const periodLabel: string = period.label;

    // Récupérer agenda + emails : si tu as un RPC, utilise-le ;
    // sinon, fallback join (ici on part sur le RPC existant côté projet).
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

    // Regrouper par email
    const byEmail = new Map<string, { name: string; items: AgendaRow[] }>();
    for (const r of list) {
      const email = (r.email || '').trim();
      if (!email) continue;
      const cur = byEmail.get(email) ?? { name: (r.full_name || '').trim(), items: [] };
      cur.items.push(r);
      byEmail.set(email, cur);
    }

    // Envoi par batch + retry 429
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || '';
    const FROM_EMAIL =
      process.env.PLANNING_FROM_EMAIL ||
      process.env.SMTP_FROM ||
      'planning@mmg.example';

    const recipients = Array.from(byEmail.entries()); // [email, {name, items}]
    let sent = 0;
    const BATCH = 30;
    const PAUSE_MS = 200;

    const chunk = <T,>(arr: T[], n: number) => {
      const out: T[][] = [];
      for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
      return out;
    };

    const batches = chunk(recipients, BATCH);

    for (const group of batches) {
      // Envois séquentiels dans le batch (pour lisser le débit)
      for (const [email, { name, items }] of group) {
        items.sort(
          (a, b) =>
            a.date.localeCompare(b.date) ||
            a.kind.localeCompare(b.kind)
        );

        // Corps “agenda” en tableau HTML (pour info visuelle)
        const table = items
          .map((it) => {
            const d = formatDateFR(it.date);
            const kr = formatKindFR(it.kind);
            const who = (it.display_name ?? it.full_name ?? '').toString();
            return `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;">${d}</td><td style="padding:6px 8px;border-bottom:1px solid #eee;">${kr}</td><td style="padding:6px 8px;border-bottom:1px solid #eee;">${who}</td></tr>`;
          })
          .join('');

        // Template pro
        const { subject, html, text } = emailPlanningReady({
          name,
          periodLabel: periodLabel,
          siteUrl: siteUrl || '',
        });

        // On injecte la table juste après le premier paragraphe du template
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
        ${table}
      </tbody>
    </table>
    <p>Le planning`
        );

        const trySend = async () => {
          try {
            await sendEmail({
              to: email,
              subject,
              html: htmlWithTable,
              text,
              fromOverride: FROM_EMAIL,
            });
            return true;
          } catch (err: any) {
            // sendEmail (Resend) remonte un message "429: ..." en cas de rate limit
            const msg = String(err?.message || '');
            if (msg.startsWith('429')) return 'retry';
            return false;
          }
        };

        // 1er essai
        const ok1 = await trySend();
        if (ok1 === true) {
          sent++;
          continue;
        }

        // Retry si 429
        if (ok1 === 'retry') {
          await new Promise((r) => setTimeout(r, 800));
          const ok2 = await trySend();
          if (ok2 === true) {
            sent++;
            continue;
          }
        }

        // Sinon : on log et on continue (ne bloque pas les autres)
        console.warn('[email-planning] Échec d’envoi à', email);
      }

      // Petite pause entre batches pour rester sous les limites
      await new Promise((r) => setTimeout(r, PAUSE_MS));
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
