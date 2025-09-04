import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// Option: Resend (ou SendGrid)
const RESEND_API_KEY = process.env.RESEND_API_KEY!;
const FROM_EMAIL = process.env.PLANNING_FROM_EMAIL || "planning@mmg.example";

export async function POST(req: NextRequest) {
  try {
    // (facultatif) vérifier que l’appelant est admin
    const auth = req.headers.get("authorization");
    if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { period_id } = await req.json();
    if (!period_id) return NextResponse.json({ error: "period_id manquant" }, { status: 400 });

    // Récupère les assignations validées pour la période, joint nom & email
    // Hypothèse: profiles(user_id PK) + full_name, role; emails via auth.users
    const { data: rows, error } = await supa.rpc("get_agenda_with_emails", { q_period_id: period_id });
    if (error) throw error;

    // Regroupe par médecin (email)
    const byEmail = new Map<string, { name: string; items: any[] }>();
    for (const r of rows as any[]) {
      const key = r.email;
      const cur = byEmail.get(key) ?? { name: r.full_name, items: [] };
      cur.items.push(r);
      byEmail.set(key, cur);
    }

    const sendOne = async (to: string, name: string, items: any[]) => {
      // Petit HTML simple
      const table = items
        .sort((a,b)=> (a.date as string).localeCompare(b.date) || (a.kind as string).localeCompare(b.kind))
        .map((it: any) => {
          const d = formatDateFR(it.date);
          const kr = formatKindFR(it.kind);
          return `<tr><td>${d}</td><td>${kr}</td><td>${it.display_name}</td></tr>`;
        }).join("");

      const html = `
        <p>Bonjour ${name || ""},</p>
        <p>Voici le planning validé de la période <strong>${rows?.[0]?.period_label ?? ""}</strong> :</p>
        <table border="1" cellpadding="6" cellspacing="0">
          <thead><tr><th>Date</th><th>Créneau</th><th>Médecin</th></tr></thead>
          <tbody>${table}</tbody>
        </table>
        <p>— Maison Médicale de Garde</p>
      `;

      // Envoi via Resend
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to,
          subject: "Planning MMG – période validée",
          html,
        }),
      });
    };

    // helpers locaux (mêmes formats que côté client)
    const KIND_TIME: Record<string, [string, string]> = {
      WEEKDAY_20_00: ["20:00","00:00"], SAT_12_18: ["12:00","18:00"], SAT_18_00: ["18:00","00:00"],
      SUN_08_14: ["08:00","14:00"], SUN_14_20: ["14:00","20:00"], SUN_20_24: ["20:00","00:00"],
    };
    const formatDateFR = (ymd: string) => {
      const d = new Date(`${ymd}T00:00:00`);
      const day = d.toLocaleDateString("fr-FR", { weekday: "long" });
      const month = d.toLocaleDateString("fr-FR", { month: "long" });
      const dd = d.getDate();
      const ddStr = dd === 1 ? "1er" : String(dd);
      const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
      return `${cap(day)} ${ddStr} ${month}`;
    };
    const formatKindFR = (kind: string) => {
      const t = KIND_TIME[kind]; if (!t) return kind;
      const h = (s: string) => s.replace(":", "h");
      return `${h(t[0])} - ${h(t[1])}`;
    };

    // Envoi (par lots)
    let sent = 0;
    for (const [email, { name, items }] of byEmail.entries()) {
      if (!email) continue;
      await sendOne(email, name, items);
      sent++;
    }

    return NextResponse.json({ sent_count: sent });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json({ error: e?.message ?? "Server error" }, { status: 500 });
  }
}
