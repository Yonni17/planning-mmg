// app/api/doctor-months/route.ts
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

// ---- helpers ----
async function getAccessTokenFromCookies(): Promise<string | null> {
  const store = await cookies();
  const ref = new URL(SUPABASE_URL).host.split(".")[0];
  const base = `sb-${ref}-auth-token`;

  const c0 = store.get(`${base}.0`)?.value ?? "";
  const c1 = store.get(`${base}.1`)?.value ?? "";
  const c = store.get(base)?.value ?? "";
  const raw = c0 || c1 ? `${c0}${c1}` : c;
  if (!raw) return null;

  let txt = raw;
  try {
    txt = decodeURIComponent(raw);
  } catch {}
  try {
    const parsed = JSON.parse(txt);
    if (parsed?.access_token) return parsed.access_token as string;
    if (parsed?.currentSession?.access_token)
      return parsed.currentSession.access_token as string;
  } catch {}
  return null;
}

function yyyymm(dateStr: string): string {
  // dateStr attendu: 'YYYY-MM-DD'
  return dateStr.slice(0, 7);
}
// -----------------

/**
 * GET /api/doctor-months?period_id=...
 * -> renvoie la liste des mois de la période + l'état de validation de l'utilisateur courant
 *    et les flags (all_validated, opted_out)
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const period_id = searchParams.get("period_id") ?? "";

    if (!period_id) {
      return NextResponse.json(
        { error: "period_id requis" },
        { status: 400 }
      );
    }

    // Auth
    const tokenFromAuth = req.headers
      .get("authorization")
      ?.toLowerCase()
      .startsWith("bearer ")
      ? req.headers.get("authorization")!.slice(7).trim()
      : null;
    let access_token = tokenFromAuth ?? (await getAccessTokenFromCookies());
    if (!access_token) {
      return NextResponse.json(
        { error: "Auth session missing!" },
        { status: 401 }
      );
    }

    const { data: userData, error: userErr } =
      await supabaseAnon.auth.getUser(access_token);
    if (userErr || !userData.user) {
      return NextResponse.json(
        { error: userErr?.message ?? "Unauthorized" },
        { status: 401 }
      );
    }
    const uid = userData.user.id;

    // 1) récupérer les mois présents dans les slots de la période
    const { data: slots, error: slotsErr } = await supabaseAnon
      .from("slots")
      .select("date")
      .eq("period_id", period_id);
    if (slotsErr)
      return NextResponse.json({ error: slotsErr.message }, { status: 500 });

    const monthSet = new Set<string>();
    for (const s of slots ?? []) {
      if (s.date) monthSet.add(yyyymm(s.date));
    }
    const months = Array.from(monthSet).sort();

    // 2) état de validation de l'utilisateur
    const { data: dpm, error: dpmErr } = await supabaseAnon
      .from("doctor_period_months")
      .select("month_key, validated_at")
      .eq("user_id", uid)
      .eq("period_id", period_id);
    if (dpmErr)
      return NextResponse.json({ error: dpmErr.message }, { status: 500 });

    const validatedMap = new Map<string, string | null>();
    for (const row of dpm ?? []) {
      validatedMap.set(row.month_key, row.validated_at);
    }

    // 3) flags
    const { data: flagsRow, error: flagsErr } = await supabaseAnon
      .from("doctor_period_flags")
      .select("all_validated, opted_out, locked")
      .eq("user_id", uid)
      .eq("period_id", period_id)
      .maybeSingle();
    if (flagsErr)
      return NextResponse.json({ error: flagsErr.message }, { status: 500 });

    return NextResponse.json({
      period_id,
      months: months.map((m) => ({
        month_key: m,
        validated_at: validatedMap.get(m) ?? null,
      })),
      flags: {
        all_validated: flagsRow?.all_validated ?? false,
        opted_out: flagsRow?.opted_out ?? false,
        locked: flagsRow?.locked ?? false,
      },
    });
  } catch (e: any) {
    console.error("[doctor-months GET]", e);
    return NextResponse.json(
      { error: e?.message ?? "Server error" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/doctor-months
 * body:
 *   { action: 'toggle_validate', period_id, month_key, value: boolean }
 *   { action: 'opt_out',        period_id, value: boolean }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = String(body?.action ?? "");
    const period_id = String(body?.period_id ?? "");

    if (!period_id) {
      return NextResponse.json(
        { error: "period_id requis" },
        { status: 400 }
      );
    }

    // Auth
    const tokenFromAuth = req.headers
      .get("authorization")
      ?.toLowerCase()
      .startsWith("bearer ")
      ? req.headers.get("authorization")!.slice(7).trim()
      : null;
    let access_token = tokenFromAuth ?? (await getAccessTokenFromCookies());
    if (!access_token) {
      return NextResponse.json(
        { error: "Auth session missing!" },
        { status: 401 }
      );
    }

    const { data: userData, error: userErr } =
      await supabaseAnon.auth.getUser(access_token);
    if (userErr || !userData.user) {
      return NextResponse.json(
        { error: userErr?.message ?? "Unauthorized" },
        { status: 401 }
      );
    }
    const uid = userData.user.id;

    if (action === "toggle_validate") {
      const month_key = String(body?.month_key ?? "");
      const value: boolean = !!body?.value;
      if (!month_key || !/^\d{4}-\d{2}$/.test(month_key)) {
        return NextResponse.json(
          { error: "month_key invalide" },
          { status: 400 }
        );
      }

      if (value) {
        // upsert avec validated_at = now()
        const { error: insErr } = await supabaseAnon
          .from("doctor_period_months")
          .upsert(
            {
              user_id: uid,
              period_id,
              month_key,
              validated_at: new Date().toISOString(),
            },
            { onConflict: "user_id,period_id,month_key" }
          );
        if (insErr)
          return NextResponse.json({ error: insErr.message }, { status: 500 });
      } else {
        // mettre validated_at = null (ou delete)
        const { error: updErr } = await supabaseAnon
          .from("doctor_period_months")
          .update({ validated_at: null })
          .eq("user_id", uid)
          .eq("period_id", period_id)
          .eq("month_key", month_key);
        if (updErr)
          return NextResponse.json({ error: updErr.message }, { status: 500 });
      }

      // Recalcul all_validated (3 mois validés) si besoin
      const { data: slots, error: slotsErr } = await supabaseAnon
        .from("slots")
        .select("date")
        .eq("period_id", period_id);
      if (slotsErr)
        return NextResponse.json({ error: slotsErr.message }, { status: 500 });

      const monthsInPeriod = new Set<string>();
      for (const s of slots ?? []) if (s.date) monthsInPeriod.add(yyyymm(s.date));

      const { data: dpm, error: dpmErr } = await supabaseAnon
        .from("doctor_period_months")
        .select("month_key, validated_at")
        .eq("user_id", uid)
        .eq("period_id", period_id);
      if (dpmErr)
        return NextResponse.json({ error: dpmErr.message }, { status: 500 });

      let validatedCount = 0;
      for (const m of monthsInPeriod) {
        const row = dpm?.find((r) => r.month_key === m);
        if (row && row.validated_at) validatedCount++;
      }
      const allValidated = validatedCount === monthsInPeriod.size && monthsInPeriod.size > 0;

      const { error: flagsErr } = await supabaseAnon
        .from("doctor_period_flags")
        .upsert(
          {
            user_id: uid,
            period_id,
            all_validated: allValidated,
          },
          { onConflict: "user_id,period_id" }
        );
      if (flagsErr)
        return NextResponse.json({ error: flagsErr.message }, { status: 500 });

      return NextResponse.json({ ok: true });
    }

    if (action === "opt_out") {
      const value: boolean = !!body?.value;

      // Quand opt_out = true, on considère l'utilisateur "à jour" (all_validated = true)
      const { error: flagsErr } = await supabaseAnon
        .from("doctor_period_flags")
        .upsert(
          {
            user_id: uid,
            period_id,
            opted_out: value,
            all_validated: value ? true : false, // si on revient à false, on remettra all_validated à false (il devra valider les mois)
          },
          { onConflict: "user_id,period_id" }
        );
      if (flagsErr)
        return NextResponse.json({ error: flagsErr.message }, { status: 500 });

      return NextResponse.json({ ok: true });
    }

    return NextResponse.json(
      { error: "action inconnue" },
      { status: 400 }
    );
  } catch (e: any) {
    console.error("[doctor-months POST]", e);
    return NextResponse.json(
      { error: e?.message ?? "Server error" },
      { status: 500 }
    );
  }
}
