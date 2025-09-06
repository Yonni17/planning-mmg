// app/admin/invites/page.tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type Row = {
  email: string;
  invite: {
    status: 'pending' | 'sent' | 'accepted' | 'revoked' | string;
    invited_at: string | null;
    accepted_at: string | null;
    last_sent_at: string | null;
    revoked_at: string | null;
    role: 'doctor' | 'admin' | string;
    full_name: string | null;
  };
  user: null | {
    id: string;
    last_sign_in_at: string | null;
    confirmed_at: string | null;
    created_at: string | null;
  };
  profile: null | {
    first_name: string | null;
    last_name: string | null;
    role: string | null;
  };
  period: {
    id: string | null;
    label: string | null;
    months_total: number;
    months_validated: number;
    all_validated: boolean;
    opted_out: boolean;
  };
};

type Period = { id: string; label: string };

function fmt(d?: string | null) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  } catch { return d; }
}

// parse JSON sans planter si le serveur ne renvoie pas de JSON
async function parseJsonSafe(res: Response) {
  const txt = await res.text();
  try {
    return txt ? JSON.parse(txt) : {};
  } catch {
    return { __raw: txt };
  }
}

export default function AdminInvitationsPage() {
  const [meEmail, setMeEmail] = useState<string | null>(null);
  const [emailsText, setEmailsText] = useState('');
  const [sending, setSending] = useState(false);

  const [rows, setRows] = useState<Row[]>([]);
  const [period, setPeriod] = useState<{ id: string | null; label: string | null; months_total: number } | null>(null);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [periodId, setPeriodId] = useState<string>('');

  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [q, setQ] = useState('');

  const [resending, setResending] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  // --------- INIT ---------
  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      setMeEmail(session?.user?.email ?? null);

      // Charge la liste des périodes pour le sélecteur
      const { data: pData, error: pErr } = await supabase
        .from('periods')
        .select('id,label')
        .order('open_at', { ascending: false });
      if (!pErr && pData?.length) {
        setPeriods(pData);
        const def = pData[0]?.id ?? '';
        setPeriodId(def);
        await load(def);
      } else {
        // pas de période en base, on tente quand même l’overview côté API qui sait trouver une période courante
        await load(undefined);
      }
    })().finally(() => setLoading(false));
  }, []);

  // --------- LOAD OVERVIEW ---------
  async function load(pid?: string) {
    setLoading(true);
    setMsg(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const url = pid ? `/api/admin/invites?period_id=${encodeURIComponent(pid)}` : '/api/admin/invites';
      const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      const json = await parseJsonSafe(res);
      if (!res.ok) {
        const err = (json as any)?.error || (json as any)?.message || `HTTP ${res.status}`;
        throw new Error(err);
      }
      setRows((json as any).rows as Row[]);
      setPeriod((json as any).period);
    } catch (e: any) {
      setMsg(`❌ ${e.message ?? 'Erreur de chargement'}`);
    } finally {
      setLoading(false);
    }
  }

  // --------- FILTER ---------
  const filtered = useMemo(() => {
    if (!q.trim()) return rows;
    const s = q.trim().toLowerCase();
    return rows.filter(r =>
      r.email.toLowerCase().includes(s) ||
      (r.profile?.first_name?.toLowerCase() ?? '').includes(s) ||
      (r.profile?.last_name?.toLowerCase() ?? '').includes(s) ||
      (r.invite?.full_name?.toLowerCase() ?? '').includes(s)
    );
  }, [rows, q]);

  // --------- INVITE FORM ---------
  // On laisse le back parser "Nom <email>" : on envoie juste chaque morceau non vide
  const splitEntries = (txt: string) =>
    txt.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);

  async function sendInvites() {
    const entries = splitEntries(emailsText);
    if (!entries.length) { setMsg('Veuillez saisir au moins un email.'); return; }

    setSending(true);
    setMsg(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Session invalide — reconnectez-vous.');

      const res = await fetch('/api/admin/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ emails: entries, role: 'doctor' }),
      });
      const json = await parseJsonSafe(res);
      if (!res.ok) {
        const err = (json as any)?.error || (json as any)?.message || `HTTP ${res.status}`;
        throw new Error(err);
      }
      setMsg(`✅ Invitations envoyées: ${(json as any).invited}, déjà invit.: ${(json as any).already_invited}, déjà inscrits: ${(json as any).already_registered}, échecs: ${(json as any).failed}`);
      setEmailsText('');
      await load(periodId || period?.id || undefined);
    } catch (e: any) {
      setMsg(`❌ ${e.message ?? 'Échec envoi'}`);
    } finally {
      setSending(false);
    }
  }

  // --------- ACTIONS LIGNE ---------
  async function actionResend(email: string) {
    try {
      setResending(email);
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const res = await fetch('/api/admin/invites/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ email }),
      });
      const j = await parseJsonSafe(res);
      if (!res.ok) {
        const err = (j as any)?.error || (j as any)?.message || `HTTP ${res.status}`;
        throw new Error(err);
      }
      setMsg(`📨 Réinvitation envoyée à ${email}`);
      await load(periodId || period?.id || undefined);
    } catch (e: any) {
      setMsg(`❌ ${e.message ?? 'Erreur envoi'}`);
    } finally {
      setResending(null);
    }
  }

  async function actionRevoke(email: string) {
    if (!confirm(`Révoquer l’invitation de ${email} ?`)) return;
    try {
      setRevoking(email);
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const res = await fetch('/api/admin/invites/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ email }),
      });
      const j = await parseJsonSafe(res);
      if (!res.ok) {
        const err = (j as any)?.error || (j as any)?.message || `HTTP ${res.status}`;
        throw new Error(err);
      }
      setMsg(`🚫 Invitation révoquée pour ${email}`);
      await load(periodId || period?.id || undefined);
    } catch (e: any) {
      setMsg(`❌ ${e.message ?? 'Erreur révocation'}`);
    } finally {
      setRevoking(null);
    }
  }

  return (
    <div className="mx-auto max-w-6xl p-6 space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold text-white">Gestion des utilisateurs & invitations</h1>
        <div className="ml-auto text-xs text-zinc-400">Connecté en tant que {meEmail ?? '—'}</div>
      </div>

      {msg && (
        <div className={`p-3 rounded border ${msg.startsWith('❌') ? 'border-red-700 bg-red-900/30 text-red-200' : 'border-emerald-700 bg-emerald-900/30 text-emerald-200'}`}>
          {msg}
        </div>
      )}

      {/* Formulaire envoi d'invitations */}
      <div className="rounded-xl border border-zinc-700 bg-zinc-800/60 p-4 space-y-3">
        <label className="block text-sm text-zinc-300">
          Collez une liste d’entrées (emails simples ou <code>Nom {'<'}email{'>'}</code>), séparées par virgule / point-virgule / retour à la ligne :
        </label>
        <textarea
          className="w-full min-h-36 rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-100 p-3 placeholder-zinc-500"
          placeholder={`Exemples :\nJean Dupont <jean.dupont@exemple.com>\nmarie@exemple.com, nicolas@exemple.com`}
          value={emailsText}
          onChange={(e) => setEmailsText(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2 justify-between">
          <div className="text-xs text-zinc-400">Un lien magique sera envoyé.</div>
          <button
            onClick={sendInvites}
            disabled={sending}
            className="px-4 py-2 rounded-lg border border-blue-500 text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50"
          >
            {sending ? 'Envoi…' : 'Envoyer les invitations'}
          </button>
        </div>
      </div>

      {/* Barre outils liste */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm text-zinc-300">Période :</span>
          <select
            className="border rounded px-2 py-1 bg-zinc-900 text-zinc-100 border-zinc-700"
            value={periodId}
            onChange={async (e) => {
              const v = e.target.value;
              setPeriodId(v);
              await load(v || undefined);
            }}
          >
            <option value="">— auto —</option>
            {periods.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <span className="text-sm text-zinc-300">
            {period?.label ? <span className="ml-2">({period.label}{period?.months_total ? ` · ${period.months_total} mois` : ''})</span> : null}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <input
            className="rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-100 px-3 py-1.5 w-64"
            placeholder="Rechercher (nom, email)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button
            onClick={() => load(periodId || undefined)}
            className="px-3 py-1.5 rounded-lg border border-zinc-700 text-zinc-100 hover:bg-zinc-800"
          >
            Rafraîchir
          </button>
        </div>
      </div>

      {/* Tableau */}
      <div className="overflow-x-auto rounded-xl border border-zinc-700">
        <table className="min-w-full text-sm">
          <thead className="bg-zinc-900/60 text-zinc-300">
            <tr>
              <th className="px-3 py-2 text-left">Utilisateur</th>
              <th className="px-3 py-2 text-left">Email</th>
              <th className="px-3 py-2">Invite</th>
              <th className="px-3 py-2">Check-in</th>
              <th className="px-3 py-2">Période</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800 bg-zinc-900/30 text-zinc-200">
            {loading ? (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-zinc-400">Chargement…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-zinc-400">Aucun résultat</td></tr>
            ) : filtered.map((r) => {
              const name = r.profile
                ? `${r.profile.first_name ?? ''} ${r.profile.last_name ?? ''}`.trim() || (r.invite.full_name ?? '')
                : (r.invite.full_name ?? '');
              const statusBadge =
                r.invite.status === 'accepted' ? 'bg-emerald-700/30 text-emerald-200 border-emerald-700/50' :
                r.invite.status === 'revoked' ? 'bg-red-700/30 text-red-200 border-red-700/50' :
                'bg-zinc-700/30 text-zinc-200 border-zinc-700/50';

              const progress =
                r.period.opted_out ? 'Dispensé' :
                `${r.period.months_validated}/${r.period.months_total}`;
              const progressBadge =
                r.period.opted_out ? 'bg-amber-700/30 text-amber-200 border-amber-700/50' :
                r.period.all_validated ? 'bg-emerald-700/30 text-emerald-200 border-emerald-700/50' :
                'bg-zinc-700/30 text-zinc-200 border-zinc-700/50';

              const isResending = resending === r.email;
              const isRevoking = revoking === r.email;

              return (
                <tr key={r.email}>
                  <td className="px-3 py-2">
                    <div className="font-medium text-white">{name || '—'}</div>
                    <div className="text-xs text-zinc-400">{r.profile?.role || r.invite.role}</div>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <div>{r.email}</div>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <div className={`inline-block px-2 py-0.5 rounded border text-xs ${statusBadge}`}>{r.invite.status}</div>
                    <div className="text-xs text-zinc-400 mt-1">
                      Invité: {fmt(r.invite.invited_at)}<br/>
                      Accepté: {fmt(r.invite.accepted_at)}<br/>
                      Dernier envoi: {fmt(r.invite.last_sent_at)}
                    </div>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <div className="text-xs text-zinc-300">
                      Créé: {fmt(r.user?.created_at)}<br/>
                      Confirmé: {fmt(r.user?.confirmed_at)}<br/>
                      Dernière connexion: <span className={r.user?.last_sign_in_at ? 'text-emerald-300' : 'text-zinc-400'}>{fmt(r.user?.last_sign_in_at)}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <div className="text-xs text-zinc-300">{r.period.label ?? '—'}</div>
                    <div className={`inline-block mt-1 px-2 py-0.5 rounded border text-xs ${progressBadge}`}>
                      {progress}
                    </div>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <div className="flex flex-wrap gap-2">
                      {(r.invite.status !== 'accepted' && r.invite.status !== 'revoked') && (
                        <button
                          onClick={() => actionResend(r.email)}
                          disabled={isResending}
                          className="px-2 py-1 rounded border border-blue-500 text-white bg-blue-600 hover:bg-blue-500 text-xs disabled:opacity-50"
                        >
                          {isResending ? '…' : 'Réinviter'}
                        </button>
                      )}
                      {(r.invite.status !== 'revoked') && (
                        <button
                          onClick={() => actionRevoke(r.email)}
                          disabled={isRevoking}
                          className="px-2 py-1 rounded border border-red-500 text-red-200 hover:bg-red-900/30 text-xs disabled:opacity-50"
                        >
                          {isRevoking ? '…' : 'Révoquer'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-zinc-500">
        Astuce : la colonne “Période” affiche le nombre de mois validés par utilisateur sur la période sélectionnée.
        Si “Dispensé”, l’utilisateur a choisi l’option d’exemption (opt-out).
      </p>
    </div>
  );
}
