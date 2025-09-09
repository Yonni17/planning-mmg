// app/api/admin/invites/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** ================== Helpers auth (Bearer ou cookies Supabase) ================== */
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

/** ================== Utils ================== */
const pad = (n: number) => String(n).padStart(2, '0');
const yyyymm = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;

// Accepte: "Jean Dupont <jean@ex.com>" ou "jean@ex.com"
function parseLineToContact(raw: string): { email: string; full_name?: string } | null {
  const s = String(raw || '').trim();
  if (!s) return null;

  const m = s.match(/^(.*?)<\s*([^<>@\s]+@[^<>\s]+)\s*>$/);
  if (m) {
    const name = m[1].trim().replace(/^"|"$/g, '');
    const email = m[2].toLowerCase();
    if (!email.includes('@')) return null;
    return { email, full_name: name || undefined };
  }

  if (/\S+@\S+\.\S+/.test(s)) {
    return { email: s.toLowerCase() };
  }
  return null;
}

// Si pas de full_name donné, on devine depuis l'email
function guessFullNameFromEmail(email: string): string {
  const local = email.split('@')[0] || '';
  const cleaned = local
    .replace(/[._-]+/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return email;
  return cleaned
    .split(' ')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

async function pickPeriod(supabase: ReturnType<typeof getSupabaseAdmin>, periodId?: string) {
  if (periodId) {
    const { data, error } = await supabase
      .from('periods')
      .select('id,label')
      .eq('id', periodId)
      .maybeSingle();
    if (error || !data) return null;
    return data;
  }
  // fallback: dernière période par open_at desc
  const { data, error } = await supabase
    .from('periods')
    .select('id,label')
    .order('open_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

/** ================== GET: overview pour le tableau ================== */
export async function GET(req: NextRequest) {
  const auth = await requireAdminOrResponse(req);
  if (auth.errorResponse) return auth.errorResponse;
  const supabase = auth.supabase;

  try {
    const period_id = req.nextUrl.searchParams.get('period_id') || undefined;
    const periodRow = await pickPeriod(supabase, period_id);
    if (!periodRow) {
      return NextResponse.json({ rows: [], period: { id: null, label: null, months_total: 0 } });
    }

    // months_total à partir des slots (dates uniques YYYY-MM)
    const { data: slotDates, error: slotsErr } = await supabase
      .from('slots')
      .select('date')
      .eq('period_id', periodRow.id);
    if (slotsErr) throw slotsErr;
    const monthSet = new Set<string>();
    for (const s of slotDates ?? []) {
      if ((s as any).date) {
        const d = new Date((s as any).date + 'T00:00:00Z');
        monthSet.add(yyyymm(d));
      }
    }
    const months_total = monthSet.size;

    // Invites
    const { data: invites, error: invErr } = await supabase
      .from('invites')
      .select('email,status,invited_at,accepted_at,last_sent_at,revoked_at,role,full_name');
    if (invErr) throw invErr;

    // Users (Auth)
    const usersRes = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const users = usersRes?.data?.users ?? [];

    const userByEmail = new Map<string, any>();
    users.forEach(u => {
      if (u.email) {
        userByEmail.set(u.email.toLowerCase(), {
          id: u.id,
          created_at: u.created_at ?? null,
          confirmed_at: (u as any).email_confirmed_at ?? (u as any).confirmed_at ?? null,
          last_sign_in_at: u.last_sign_in_at ?? null,
          email: u.email.toLowerCase(),
        });
      }
    });

    // Profils pour les user_ids trouvés
    const userIds = users.map(u => u.id);
    let profMap = new Map<string, { first_name: string|null; last_name: string|null; role: string|null }>();
    if (userIds.length) {
      const { data: profs, error: profErr } = await supabase
        .from('profiles')
        .select('user_id, first_name, last_name, role')
        .in('user_id', userIds);
      if (profErr) throw profErr;
      for (const p of profs ?? []) {
        profMap.set((p as any).user_id, {
          first_name: (p as any).first_name ?? null,
          last_name:  (p as any).last_name ?? null,
          role:       (p as any).role ?? null,
        });
      }
    }

    // Flags période
    const { data: flags, error: fErr } = await supabase
      .from('doctor_period_flags')
      .select('user_id, all_validated, opted_out')
      .eq('period_id', periodRow.id);
    if (fErr) throw fErr;
    const flagMap = new Map<string, { all_validated: boolean; opted_out: boolean }>();
    for (const r of flags ?? []) {
      flagMap.set((r as any).user_id, {
        all_validated: !!(r as any).all_validated,
        opted_out: !!(r as any).opted_out,
      });
    }

    // Compte des mois validés
    const { data: months, error: mErr } = await supabase
      .from('doctor_period_months')
      .select('user_id, validated_at')
      .eq('period_id', periodRow.id);
    if (mErr) throw mErr;
    const validatedCount = new Map<string, number>();
    for (const r of months ?? []) {
      const uid = (r as any).user_id as string;
      const ok = !!(r as any).validated_at;
      if (!validatedCount.has(uid)) validatedCount.set(uid, 0);
      if (ok) validatedCount.set(uid, (validatedCount.get(uid) || 0) + 1);
    }

    // Fusion emails = invites ⊔ users
    const emailsSet = new Set<string>();
    for (const inv of invites ?? []) if ((inv as any).email) emailsSet.add((inv as any).email.toLowerCase());
    for (const u of users) if (u.email) emailsSet.add(u.email.toLowerCase());

    const rows = Array.from(emailsSet).map(email => {
      const inv = (invites ?? []).find(i => (i as any).email?.toLowerCase() === email) as any | undefined;
      const user = userByEmail.get(email) as any | undefined;
      const prof = user ? profMap.get(user.id) : undefined;
      const flags = user ? flagMap.get(user.id) : undefined;
      const monthsVal = user ? (validatedCount.get(user.id) || 0) : 0;

      return {
        email,
        invite: {
          status: inv?.status ?? 'not_invited',
          invited_at: inv?.invited_at ?? null,
          accepted_at: inv?.accepted_at ?? null,
          last_sent_at: inv?.last_sent_at ?? null,
          revoked_at: inv?.revoked_at ?? null,
          role: inv?.role ?? (prof?.role ?? 'doctor'),
          full_name: inv?.full_name ?? null,
        },
        user: user ? {
          id: user.id,
          last_sign_in_at: user.last_sign_in_at ?? null,
          confirmed_at: user.confirmed_at ?? null,
          created_at: user.created_at ?? null,
        } : null,
        profile: prof ? {
          first_name: prof.first_name,
          last_name: prof.last_name,
          role: prof.role,
        } : null,
        period: {
          id: periodRow.id,
          label: periodRow.label,
          months_total,
          months_validated: monthsVal,
          all_validated: !!flags?.all_validated,
          opted_out: !!flags?.opted_out,
        },
      };
    });

    rows.sort((a, b) => a.email.localeCompare(b.email));

    return NextResponse.json({
      period: { id: periodRow.id, label: periodRow.label, months_total },
      count: rows.length,
      rows,
    });
  } catch (e: any) {
    console.error('[admin/invites GET]', e);
    return NextResponse.json({ error: e?.message ?? 'Server error' }, { status: 500 });
  }
}

/** ================== POST: envoyer des invitations ================== */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAdminOrResponse(req);
    if (auth.errorResponse) return auth.errorResponse;
    const supabase = auth.supabase;
    const adminUserId = auth.userId!;

    const body = await req.json().catch(() => ({}));

    // Nouveau : acceptons contacts[] {first_name,last_name,email}
    const contactsIn: any[] = Array.isArray((body as any)?.contacts) ? (body as any).contacts : [];
    const emailsIn: any[] = Array.isArray((body as any)?.emails) ? (body as any).emails : [];

    const role: 'doctor' | 'admin' =
      (body as any)?.role === 'admin' ? 'admin' : 'doctor';

    // Normalisation : on construit une liste unique {email, full_name}
    const map = new Map<string, { email: string; full_name?: string }>();

    // a) depuis contacts[]
    for (const raw of contactsIn) {
      const em = String(raw?.email || '').trim().toLowerCase();
      const fn = String(raw?.first_name || '').trim();
      const ln = String(raw?.last_name || '').trim();
      if (!em || !/\S+@\S+\.\S+/.test(em)) continue;

      const full_name = (fn || ln) ? `${fn} ${ln}`.trim() : undefined;
      if (!map.has(em)) map.set(em, { email: em, full_name });
    }

    // b) fallback: depuis emails[] (ancien format : strings "Nom <email>" ou "email")
    for (const raw of emailsIn) {
      const parsed = parseLineToContact(String(raw || ''));
      if (parsed && parsed.email && !map.has(parsed.email)) {
        map.set(parsed.email, parsed);
      }
    }

    const contacts = Array.from(map.values());
    if (contacts.length === 0) {
      return NextResponse.json({ error: 'Aucune entrée valide' }, { status: 400 });
    }

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

    for (const { email, full_name } of contacts) {
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
        // Déjà user → envoyer un magic link (fallback auto)
        const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
          type: 'magiclink',
          email,
          options: { redirectTo: `${siteUrl}/auth/callback` },
        });
        if (linkErr) {
          results.push({ email, status: 'invite_failed', error: linkErr.message });
        } else {
          results.push({ email, status: 'invited' });
          await supabase
            .from('invites')
            .upsert({
              email,
              full_name: (full_name && full_name.trim()) || guessFullNameFromEmail(email),
              role,
              invited_by: adminUserId,
              status: 'sent',
              last_sent_at: new Date().toISOString(),
              invited_at: new Date().toISOString(),
            } as any, { onConflict: 'email' });
        }
        continue;
      }

      // B) déjà invité ?
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
        if ((existing as any).accepted_at) {
          results.push({ email, status: 'already_accepted' });
        } else {
          results.push({ email, status: 'already_invited' });
        }
        continue;
      }

      // C) insérer invite (assure-toi que les colonnes existent)
      const finalFullName = (full_name && full_name.trim()) || guessFullNameFromEmail(email);

      const { error: insErr } = await supabase
        .from('invites')
        .insert({
          email,
          full_name: finalFullName,
          role,
          invited_by: adminUserId,
          status: 'pending',
          invited_at: new Date().toISOString(),
        } as any);

      if (insErr && (insErr as any).code !== '23505') {
        results.push({ email, status: 'insert_failed', error: insErr.message });
        continue;
      }

      // D) envoi via Admin API: invite d'abord, fallback magiclink si déjà existant
      try {
        const { error: inviteErr } = await supabase.auth.admin.inviteUserByEmail(
          email,
          { data: { role }, redirectTo: `${siteUrl}/auth/callback` }
        );

        if (inviteErr) {
          const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
            type: 'magiclink',
            email,
            options: { redirectTo: `${siteUrl}/auth/callback` },
          });

          if (linkErr) {
            results.push({ email, status: 'invite_failed', error: linkErr.message });
          } else {
            results.push({ email, status: 'invited' });
            await supabase
              .from('invites')
              .update({ status: 'sent', last_sent_at: new Date().toISOString() })
              .eq('email', email);
          }
        } else {
          results.push({ email, status: 'invited' });
          await supabase
            .from('invites')
            .update({ status: 'sent', last_sent_at: new Date().toISOString() })
            .eq('email', email);
        }
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
