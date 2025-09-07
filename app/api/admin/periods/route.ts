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
    if (parsed?.currentSession?.access_token)
      return String(parsed.currentSession.access_token);
  } catch {}
  return null;
}

async function requireAdminOrResponse(req: NextRequest) {
  const supabase = getSupabaseAdmin();

  const token = getAccessTokenFromReq(req);
  if (!token) {
    return {
      errorResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      supabase,
      userId: null as string | null,
    };
  }

  const { data: userData, error: uErr } = await supabase.auth.getUser(token);
  if (uErr || !userData?.user) {
    return {
      errorResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      supabase,
      userId: null,
    };
  }
  const uid = userData.user.id;
  const { data: isAdmin, error: aErr } = await supabase.rpc('is_admin', { uid });
  if (aErr || !isAdmin) {
    return {
      errorResponse: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
      supabase,
      userId: uid,
    };
  }
  return { errorResponse: null as NextResponse | null, supabase, userId: uid };
}

function normStr(v: any): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

export async function GET(req: NextRequest) {
  const auth = await requireAdminOrResponse(req);
  if (auth.errorResponse) return auth.errorResponse;
  const supabase = auth.supabase;

  try {
    const { data, error } = await supabase
      .from('periods')
      .select('id,label,open_at,close_at,generate_at,timezone,created_at')
      .order('open_at', { ascending: false });
    if (error) throw error;

    return NextResponse.json({ periods: data ?? [] });
  } catch (e: any) {
    console.error('[admin/periods GET]', e);
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdminOrResponse(req);
  if (auth.errorResponse) return auth.errorResponse;
  const supabase = auth.supabase;

  try {
    const body = await req.json().catch(() => ({}));
    const label = normStr((body as any).label);
    const open_at = normStr((body as any).open_at);
    const close_at = normStr((body as any).close_at);
    const generate_at = normStr((body as any).generate_at);
    const timezone = normStr((body as any).timezone) || 'Europe/Paris';

    if (!label || !open_at || !close_at) {
      return NextResponse.json({ error: 'label, open_at et close_at sont requis' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('periods')
      .insert({
        label,
        open_at,
        close_at,
        generate_at,
        timezone,
      } as any)
      .select('id,label,open_at,close_at,generate_at,timezone,created_at')
      .single();

    if (error) throw error;

    return NextResponse.json({ period: data });
  } catch (e: any) {
    console.error('[admin/periods POST]', e);
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requireAdminOrResponse(req);
  if (auth.errorResponse) return auth.errorResponse;
  const supabase = auth.supabase;

  try {
    const body = await req.json().catch(() => ({}));
    const id = normStr((body as any).id);
    const label = normStr((body as any).label);
    const open_at = normStr((body as any).open_at);
    const close_at = normStr((body as any).close_at);
    const generate_at = normStr((body as any).generate_at);
    const timezone = normStr((body as any).timezone);

    if (!id) return NextResponse.json({ error: 'id requis' }, { status: 400 });

    const patch: any = {};
    if (label !== null) patch.label = label;
    if (open_at !== null) patch.open_at = open_at;
    if (close_at !== null) patch.close_at = close_at;
    if (generate_at !== null) patch.generate_at = generate_at;
    if (timezone !== null) patch.timezone = timezone;

    const { data, error } = await supabase
      .from('periods')
      .update(patch)
      .eq('id', id)
      .select('id,label,open_at,close_at,generate_at,timezone,created_at')
      .single();

    if (error) throw error;

    return NextResponse.json({ period: data });
  } catch (e: any) {
    console.error('[admin/periods PUT]', e);
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAdminOrResponse(req);
  if (auth.errorResponse) return auth.errorResponse;
  const supabase = auth.supabase;

  try {
    const body = await req.json().catch(() => ({}));
    const id = normStr((body as any).id);
    if (!id) return NextResponse.json({ error: 'id requis' }, { status: 400 });

    // ⚠️ si contraintes (FK slots.period_id, etc.), delete échouera si des rows existent.
    const { error } = await supabase.from('periods').delete().eq('id', id);
    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error('[admin/periods DELETE]', e);
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 });
  }
}
