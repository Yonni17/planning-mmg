// app/api/auth/can-login/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabaseService = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

export async function GET(req: NextRequest) {
  const email = String(req.nextUrl.searchParams.get('email') ?? '').trim().toLowerCase();
  if (!email) return NextResponse.json({ allowed: false });

  // autorisé si : existe dans invites (non révoqué) OU a déjà un profile (au cas où)
  const { data: inv } = await supabaseService
    .from('invites')
    .select('status')
    .eq('email', email)
    .maybeSingle();

  if (inv && inv.status !== 'revoked') {
    return NextResponse.json({ allowed: true });
  }

  // (optionnel) autoriser si déjà un profil (il peut se reconnecter)
  const { data: prof } = await supabaseService
    .from('profiles')
    .select('user_id')
    .eq('full_name', email) // <-- si full_name != email, mieux vaut vérifier via auth.users. Sans accès direct: laissons false si pas invite.
    .limit(1);
  // Par défaut, ne pas autoriser sur ce fallback, à moins d’un mapping email->profile.
  return NextResponse.json({ allowed: false });
}
