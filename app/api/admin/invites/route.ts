// app/api/admin/invites/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** ---- Helpers auth (Bearer ou cookies Supabase) ---- */
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
        { error: 'Unauthorized' },
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
        { error: 'Unauthorized' },
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
        { error: 'Forbidden' },
        { status: 403 }
      ),
      supabase,
      userId: uid,
    };
  }

  return { errorResponse: null as NextResponse | null, supabase, userId: uid };
}

/** ---- Handler ---- */
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

    // Normalisation + dédup côté payload
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
      // A) déjà un compte ?
      const { data: exUser, error: exErr } = await supabase.rpc(
        'user_exists_by_email',
        { in_email: email }
      );
      if (exErr) {
        results.push({ email, status: 'insert_failed', error: exErr.message });
        continue;
      }
      if (exUser === true) {
        results.push({ email, status: 'already_registered' });
        continue;
      }

      // B) déjà invité chez nous ?
      const { data: existing, error: existErr } = await supabase
        .from('invites')
        .select('id, accepted_at, status')
        .eq('email', email)
        .maybeSingle();
      if (existErr) {
        results.push({ email, status: 'insert_failed', error: existErr.message });
        continue;
      }
      if (existing) {
        results.push({
          email,
          status: (existing as any).accepted_at
            ? 'already_accepted'
            : 'already_invited',
        });
        continue;
      }

      // C) insérer (protégé par unique constraint)
      const { error: insErr } = await supabase
        .from('invites')
        .insert({ email, role, invited_by: adminUserId, status: 'pending' });

      // 23505 = unique_violation
      if (insErr && (insErr as any).code !== '23505') {
        results.push({ email, status: 'insert_failed', error: insErr.message });
        continue;
      }

      // D) envoyer l’invitation via l’Admin API (Magic Link d’invitation)
      try {
        const { error: inviteErr } = await supabase.auth.admin.inviteUserByEmail(
          email,
          {
            data: { role },
            redirectTo: `${siteUrl}/auth/callback`,
          }
        );
        if (inviteErr) {
          results.push({ email, status: 'invite_failed', error: inviteErr.message });
        } else {
          results.push({ email, status: 'invited' });
        }
      } catch (e: any) {
        results.push({
          email,
          status: 'invite_failed',
          error: e?.message ?? 'unknown error',
        });
      }
    }

    return NextResponse.json({
      invited: results.filter((r) => r.status === 'invited').length,
      already_registered: results.filter((r) => r.status === 'already_registered').length,
      already_invited: results.filter((r) => r.status === 'already_invited').length,
      already_accepted: results.filter((r) => r.status === 'already_accepted').length,
      failed: results.filter(
        (r) => r.status === 'invite_failed' || r.status === 'insert_failed'
      ).length,
      results,
    });
  } catch (e: any) {
    console.error('[admin/invites]', e);
    return NextResponse.json(
      { error: e?.message ?? 'Server error' },
      { status: 500 }
    );
  }
}
