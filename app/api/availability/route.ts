// app/api/availability/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function requireAuthHeader(req: NextRequest): string | null {
  const auth = req.headers.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return null;
}

export async function GET(req: NextRequest) {
  const supabase = getSupabaseAdmin();
  const token = requireAuthHeader(req);
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: userData, error: uErr } = await supabase.auth.getUser(token);
  if (uErr || !userData?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const uid = userData.user.id;

  const start = req.nextUrl.searchParams.get('start')!;
  const days = Number(req.nextUrl.searchParams.get('days') || 7);

  const startDate = new Date(start + 'T00:00:00Z');
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + days);

  const { data, error } = await supabase
    .from('doctor_availability')
    .select('slot, available')
    .eq('user_id', uid)
    .gte('slot', startDate.toISOString())
    .lt('slot', endDate.toISOString());

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const slots: Record<string, boolean> = {};
  for (const row of data ?? []) {
    // clé “YYYY-MM-DD HH:MM”
    const dt = new Date((row as any).slot);
    const key = `${dt.toISOString().slice(0,10)} ${dt.toISOString().slice(11,16)}`;
    slots[key] = !!(row as any).available;
  }
  return NextResponse.json({ slots });
}

export async function POST(req: NextRequest) {
  const supabase = getSupabaseAdmin();
  const token = requireAuthHeader(req);
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: userData, error: uErr } = await supabase.auth.getUser(token);
  if (uErr || !userData?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const uid = userData.user.id;

  const body = await req.json().catch(() => ({}));
  const changes = (body as any)?.changes as Record<string, boolean> | undefined;
  if (!changes || typeof changes !== 'object') {
    return NextResponse.json({ error: 'changes requis' }, { status: 400 });
  }

  // upsert silencieux
  const rows = Object.entries(changes).map(([k, val]) => {
    // k = "YYYY-MM-DD HH:MM"
    const iso = k.replace(' ', 'T') + ':00Z';
    return { user_id: uid, slot: iso, available: !!val };
  });

  const { error } = await supabase
    .from('doctor_availability')
    .upsert(rows, { onConflict: 'user_id,slot' });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
