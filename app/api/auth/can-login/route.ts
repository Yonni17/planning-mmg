// app/api/auth/can-login/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const email = String(req.nextUrl.searchParams.get('email') ?? '')
      .trim()
      .toLowerCase();

    if (!email) return NextResponse.json({ allowed: false });

    const supabase = getSupabaseAdmin();

    // 1) Chemin "officiel" : allowlist via RPC
    //    -> doit retourner un booléen
    const { data: allowedByRpc, error: rpcErr } = await supabase.rpc(
      'user_exists_by_email',
      { in_email: email }
    );

    if (rpcErr) {
      // On journalise mais on continue avec un fallback
      console.warn('[can-login] RPC user_exists_by_email error:', rpcErr.message);
    } else if (typeof allowedByRpc === 'boolean') {
      return NextResponse.json({ allowed: allowedByRpc });
    }

    // 2) Fallback : on considère "autorisé" si une invite existe et n’est pas révoquée
    const { data: inv, error: invErr } = await supabase
      .from('invites')
      .select('status')
      .eq('email', email)
      .maybeSingle();

    if (invErr) {
      console.warn('[can-login] invites read error:', invErr.message);
      // prudence: en cas d’erreur DB on n’autorise pas
      return NextResponse.json({ allowed: false });
    }

    const allowed = !!inv && inv.status !== 'revoked';
    return NextResponse.json({ allowed });
  } catch (e: any) {
    console.error('[can-login]', e);
    // ne pas fuiter d’info: on répond simplement false
    return NextResponse.json({ allowed: false });
  }
}
