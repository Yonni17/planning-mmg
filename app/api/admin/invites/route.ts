// app/api/admin/invites/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** ---- Helpers auth (Bearer ou cookies Supabase) ---- */
function getAccessTokenFromReq(req: NextRequest): string | null {
  const auth = req.headers.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const c = cookies();
  const direct = c.get('sb-access-token')?.value;
  if (direct) return direct;

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

/* =========================
   GET  /api/admin/invites
   Agrège : invites + users + profils + progression période
   ========================= */
export async function GET(req: NextRequest) {
  const auth = await requireAdminOrResponse(req);
  if (auth.errorResponse) return auth.errorResponse;
  const supabase = auth.supabase;

  try {
    const period_id = req.nextUrl.searchParams.get('period_id') ?? '';

    // période courante (fallback: plus récente)
    let periodId = period_id;
    let periodLabel = '';
    if (!periodId) {
      const { data: p } = await supabase
        .from('periods')
        .select('id,label')
        .order('open_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (p?.id) { periodId = p.id; periodLabel = p.label ?? ''; }
    } else {
      const { data: p } = await supabase
        .from('periods')
        .select('label')
        .eq('id', periodId)
        .maybeSingle();
      periodLabel = p?.label ?? '';
    }

    // invites : on prend * pour supporter tous schémas
    const { data: invites, error: invErr } = await supabase
      .from('invites')
      .select('*')
      .order('email', { ascending: true });
    if (invErr) return NextResponse.json({ error: invErr.message }, { status: 500 });

    const emailSet = new Set<string>((invites ?? []).map(i => String((i as any).email).toLowerCase()));

    // users (admin API) mappés par email
    const usersByEmail = new Map<string, any>();
    let page = 1;
    while (true) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) break;
      const batch = data?.users ?? [];
      for (const u of batch) {
        const e = (u.email || '').toLowerCase();
        if (emailSet.has(e)) usersByEmail.set(e, u);
      }
      if (batch.length < 1000) break;
      page++;
    }

    // profils pour ces users
    const userIds = Array.from(usersByEmail.values()).map((u: any) => u.id);
    const { data: profiles } = await supabase
      .from('profiles')
      .select('user_id, first_name, last_name, role')
      .in('user_id', userIds.length ? userIds : ['_none_']);
    const profByUid = new Map<string, any>();
    for (const p of profiles ?? []) profByUid.set(p.user_id as string, p);

    // mois de la période
    const { data: slots } = await supabase
      .from('slots')
      .select('date')
      .eq('period_id', periodId || '__none__');
    const monthsSet = new Set<string>();
    for (const s of slots ?? []) if ((s as any).date) monthsSet.add(String((s as any).date).slice(0, 7));
    const monthsTotal = Array.from(monthsSet).length;

    // flags + mois validés
    const { data: flags } = await supabase
      .from('doctor_period_flags')
      .select('user_id, all_validated, opted_out')
      .eq('period_id', periodId || '__none__')
      .in('user_id', userIds.length ? userIds : ['_none_']);
    const flagsByUid = new Map<string, any>();
    for (const f of flags ?? []) flagsByUid.set((f as any).user_id as string, f);

    const { data: monthsRows } = await supabase
      .from('doctor_period_months')
      .select('user_id, month, validated_at')
      .eq('period_id', periodId || '__none__')
      .in('user_id', userIds.length ? userIds : ['_none_']);
    const validatedCountByUid = new Map<string, number>();
    for (const r of monthsRows ?? []) {
      if ((r as any).validated_at) {
        const u = (r as any).user_id as string;
        validatedCountByUid.set(u, 1 + (validatedCountByUid.get(u) ?? 0));
      }
    }

    // assembler
    const rows = (invites ?? []).map((invRaw) => {
      const inv = invRaw as any;
      const email = String(inv.email).toLowerCase();
      const user = usersByEmail.get(email);
      const uid = user?.id as string | undefined;
      const prof = uid ? profByUid.get(uid) : null;
      const f = uid ? flagsByUid.get(uid) : null;
      const validated = uid ? (validatedCountByUid.get(uid) ?? 0) : 0;

      return {
        email,
        invite: {
          status: inv.status ?? 'pending',
          invited_at: inv.created_at ?? inv.inserted_at ?? null, // tolère schémas différents
          accepted_at: inv.accepted_at ?? null,
          last_sent_at: inv.last_sent_at ?? null,
          revoked_at: inv.revoked_at ?? null,
          role: inv.role ?? 'doctor',
          full_name: inv.full_name ?? null,
        },
        user: user ? {
          id: uid!,
          last_sign_in_at: user.last_sign_in_at ?? null,
          confirmed_at: user.confirmed_at ?? user.email_confirmed_at ?? null,
          created_at: user.created_at ?? null,
        } : null,
        profile: prof ? {
          first_name: prof.first_name ?? null,
          last_name: prof.last_name ?? null,
          role: prof.role ?? null,
        } : null,
        period: {
          id: periodId || null,
          label: periodLabel || null,
          months_total: monthsTotal,
          months_validated: validated,
          all_validated: !!f?.all_validated,
          opted_out: !!f?.opted_out,
        },
      };
    });

    return NextResponse.json({
      period: { id: periodId || null, label: periodLabel || null, months_total: monthsTotal },
      count: rows.length,
      rows,
    });
  } catch (e: any) {
    console.error('[admin/invites GET]', e);
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 });
  }
}

/** ---- POST: envoi d’invitations en lot (inchangé) ---- */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAdminOrResponse(req);
    if (auth.errorResponse) return auth.errorResponse;
    const supabase = auth.supabase;
    const adminUserId = auth.userId!;

    const body = await req.json().catch(() => ({}));
    const emailsIn: unknown = (body as any)?.emails;
    const role: 'doctor' | 'admin' =
      (body as any)?.role === 'admin' ? 'admin' : 'doctor';

    if (!Array.isArray(emailsIn) || emailsIn.length === 0) {
      return NextResponse.json({ error: 'emails[] requis' }, { status: 400 });
    }

    const cleaned = Array.from(
      new Set(
        (emailsIn as unknown[])
          .map((e) => String(e ?? '').trim().toLowerCase())
          .filter((e) => e.length > 3 && e.includes('@'))
      )
    );

    const siteUrl =
      process.env.NEXT_PUBLIC_SITE_URL ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

    type Result =
      | 'invited'
      | 'already_registered'
      | 'already_invited'
      | 'already_accepted'
      | 'insert_failed'
      | 'invite_failed';

    const results: Array<{ email: string; status: Result; error?: string }> = [];

    for (const email of cleaned) {
      const { data: exUser, error: exErr } = await supabase.rpc('user_exists_by_email', { in_email: email });
      if (exErr) { results.push({ email, status: 'insert_failed', error: exErr.message }); continue; }
      if (exUser === true) { results.push({ email, status: 'already_registered' }); continue; }

      const { data: existing, error: existErr } = await supabase
        .from('invites')
        .select('id, accepted_at, status')
        .eq('email', email)
        .maybeSingle();
      if (existErr) { results.push({ email, status: 'insert_failed', error: existErr.message }); continue; }
      if (existing) {
        results.push({ email, status: (existing as any).accepted_at ? 'already_accepted' : 'already_invited' });
        continue;
      }

      const { error: insErr } = await supabase
        .from('invites')
        .insert({ email, role, invited_by: adminUserId, status: 'pending' });
      if (insErr && (insErr as any).code !== '23505') {
        results.push({ email, status: 'insert_failed', error: insErr.message });
        continue;
      }

      try {
        const { error: inviteErr } = await supabase.auth.admin.inviteUserByEmail(email, {
          data: { role },
          redirectTo: `${siteUrl}/auth/callback`,
        });
        if (inviteErr) results.push({ email, status: 'invite_failed', error: inviteErr.message });
        else results.push({ email, status: 'invited' });
      } catch (e: any) {
        results.push({ email, status: 'invite_failed', error: e?.message ?? 'unknown error' });
      }
    }

    return NextResponse.json({
      invited: results.filter((r) => r.status === 'invited').length,
      already_registered: results.filter((r) => r.status === 'already_registered').length,
      already_invited: results.filter((r) => r.status === 'already_invited').length,
      already_accepted: results.filter((r) => r.status === 'already_accepted').length,
      failed: results.filter((r) => r.status === 'invite_failed' || r.status === 'insert_failed').length,
      results,
    });
  } catch (e: any) {
    console.error('[admin/invites POST]', e);
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 });
  }
}
