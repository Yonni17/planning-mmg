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

function fmt(d?: string | null) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  } catch { return d; }
}

export default function AdminInvitationsPage() {
  const [meEmail, setMeEmail] = useState<string | null>(null);
  const [emailsText, setEmailsText] = useState('');
  const [sending, setSending] = useState(false);

  const [rows, setRows] = useState<Row[]>([]);
  const [period, setPeriod] = useState<{ id: string | null; label: string | null; months_total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      setMeEmail(session?.user?.email ?? null);
      await load();
    })();
  }, []);

  async function load(periodId?: string) {
    setLoading(true);
    setMsg(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const url = periodId ? `/api/admin/invites?period_id=${encodeURIComponent(periodId)}` : '/api/admin/invites';
      const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? 'Erreur chargement');
      setRows(json.rows as Row[]);
      setPeriod(json.period);
    } catch (e: any) {
      setMsg(`❌ ${e.message ?? 'Erreur'}`);
    } finally {
      setLoading(false);
    }
  }

  const filtered = useMemo(() => {
    if (!q.trim()) return rows;
    const s = q.trim().toLowerCase();
    return rows.filter(r =>
      r.email.includes(s) ||
      (r.profile?.first_name?.toLowerCase() ?? '').includes(s) ||
      (r.profile?.last_name?.toLowerCase() ?? '').includes(s) ||
      (r.invite?.full_name?.toLowerCase() ?? '').includes(s)
    );
  }, [rows, q]);

  const parseEmails = (txt: string) =>
    txt.split(/[\n,;]+/).map(s => s.trim().toLowerCase()).filter(s => !!s && /\S+@\S+\.\S+/.test(s));

  async function sendInvites() {
    const emails = parseEmails(emailsText);
    if (!emails.length) { setMsg('Veuillez saisir au moins un email valide.'); return; }
    setSending(true);
    setMsg(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Session invalide — reconnectez-vous.');

      const res = await fetch('/api/admin/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ emails, role: 'doctor' }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? 'Erreur serveur');
      setMsg(`✅ Invitations envoyées: ${json.invited}, déjà invit.: ${json.already_invited}, déjà inscrits: ${json.already_registered}, échecs: ${json.failed}`);
      setEmailsText('');
      await load(period?.id ?? undefined);
    } catch (e: any) {
      setMsg(`❌ ${e.message ?? 'Échec envoi'}`);
    } finally {
      setSending(false);
    }
  }

  async function actionResend(email: string) {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const res = await fetch('/api/admin/invites/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ email }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error ?? 'Échec réinvitation');
      setMsg(`📨 Réinvitation envoyée à ${email}`);
      await load(period?.id ?? undefined);
    } catch (e: any) {
      setMsg(`❌ ${e.message ?? 'Erreur envoi'}`);
    }
  }

  async function actionRevoke(email: string) {
    if (!confirm(`Révoquer l’invitation de ${email} ?`)) return;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const res = await fetch('/api/admin/invites/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ email }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error ?? 'Échec révocation');
      setMsg(`🚫 Invitation révoquée pour ${email}`);
      await load(period?.id ?? undefined);
    } catch (e: any) {
      setMsg(`❌ ${e.message ?? 'Erreur révocation'}`);
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
        <label className="block text-sm text-zinc-300">Collez une liste d’emails (séparés par virgule, point-virgule ou retour à la ligne)</label>
        <textarea
          className="w-full min-h-36 rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-100 p-3 placeholder-zinc-500"
          placeholder={`ex:\nprenom1.nom@exemple.com\nprenom2@exemple.com, prenom3@exemple.com`}
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
        <div className="text-sm text-zinc-300">
          Période : <span className="font-medium text-white">{period?.label ?? '—'}</span> {period?.months_total ? `(${period?.months_total} mois)` : ''}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <input
            className="rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-100 px-3 py-1.5 w-64"
            placeholder="Rechercher (nom, email)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button
            onClick={() => load(period?.id ?? undefined)}
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
                      {(r.invite.status !== 'accepted' && r.invite.status !== 'revoked') && ('use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type InviteRow = {
  source: 'invite' | 'user_only';
  email: string;
  invite: {
    status: 'pending' | 'sent' | 'accepted' | 'revoked' | 'not_invited';
    invited_at: string | null;
    accepted_at: string | null;
    last_sent_at: string | null;
    revoked_at: string | null;
    role: string | null;
    full_name: string | null;
  };
  user: null | {
    id: string;
    created_at: string | null;
    confirmed_at: string | null;
    last_sign_in_at: string | null;
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

type GetResp = {
  period: { id: string | null; label: string | null; months_total: number };
  count: number;
  rows: InviteRow[];
};

const fmt = (d: string | null) => (d ? new Date(d).toLocaleString() : '—');

export default function AdminInvitationsPage() {
  const [emailsText, setEmailsText] = useState('');
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const [token, setToken] = useState<string | null>(null);
  const [meEmail, setMeEmail] = useState<string | null>(null);

  const [loadingList, setLoadingList] = useState(true);
  const [list, setList] = useState<GetResp | null>(null);
  const [periodId, setPeriodId] = useState<string | null>(null); // si tu veux filtrer plus tard

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      setToken(session?.access_token ?? null);
      setMeEmail(session?.user?.email ?? null);
      await reload();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function reload() {
    if (!token) return;
    try {
      setLoadingList(true);
      const url = periodId ? `/api/admin/invites?period_id=${encodeURIComponent(periodId)}` : '/api/admin/invites';
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? 'Erreur chargement invites');
      setList(json as GetResp);
    } catch (e: any) {
      setMsg(`❌ ${e.message}`);
    } finally {
      setLoadingList(false);
    }
  }

  const parseEmails = (txt: string) => {
    return txt
      .split(/[\n,;]+/)
      .map(s => s.trim().toLowerCase())
      .filter(s => !!s && /\S+@\S+\.\S+/.test(s));
  };

  async function sendInvites() {
    const emails = parseEmails(emailsText);
    if (emails.length === 0) {
      setMsg('Veuillez saisir au moins un email valide.');
      return;
    }
    if (!token) {
      setMsg('Session invalide — reconnectez-vous.');
      return;
    }
    setSending(true);
    setMsg(null);

    try {
      const res = await fetch('/api/admin/invites', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ emails, role: 'doctor' }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? 'Erreur serveur');

      // Le POST renvoie ces compteurs :
      // invited, already_registered, already_invited, already_accepted, failed
      setMsg(
        `✅ invited:${json.invited} | already_registered:${json.already_registered} | already_invited:${json.already_invited} | already_accepted:${json.already_accepted} | failed:${json.failed}`
      );
      setEmailsText('');
      await reload(); // <-- rafraîchir la liste sous le formulaire
    } catch (e: any) {
      setMsg(`❌ ${e.message ?? 'Échec envoi'}`);
    } finally {
      setSending(false);
    }
  }

  async function doResend(email: string) {
    if (!token) return;
    try {
      const res = await fetch('/api/admin/invites/resend', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ email }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? 'Erreur resend');
      setMsg(`📧 Invitation renvoyée à ${email}`);
      await reload();
    } catch (e: any) {
      setMsg(`❌ ${e.message}`);
    }
  }

  async function doRevoke(email: string) {
    if (!token) return;
    const ok = confirm(`Révoquer l'invitation pour ${email} ?`);
    if (!ok) return;
    try {
      const res = await fetch('/api/admin/invites/revoke', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ email }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? 'Erreur revoke');
      setMsg(`⛔ Invitation révoquée pour ${email}`);
      await reload();
    } catch (e: any) {
      setMsg(`❌ ${e.message}`);
    }
  }

  async function doInvite(email: string) {
    // pour une ligne "user_only" (not_invited)
    if (!token) return;
    try {
      const res = await fetch('/api/admin/invites', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ emails: [email], role: 'doctor' }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? 'Erreur invite');
      setMsg(`✅ Invitation envoyée à ${email} (invited:${json.invited}, failed:${json.failed})`);
      await reload();
    } catch (e: any) {
      setMsg(`❌ ${e.message}`);
    }
  }

  const rows = list?.rows ?? [];
  const periodSummary = useMemo(() => {
    if (!list?.period) return '';
    const p = list.period;
    return p.label ? `${p.label} • ${p.months_total} mois` : '';
  }, [list]);

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-semibold text-white">Gestion des utilisateurs & invitations</h1>

      {msg && (
        <div className={`p-3 rounded border ${msg.startsWith('❌') ? 'border-red-700 bg-red-900/30 text-red-200' : 'border-green-700 bg-green-900/30 text-green-200'}`}>
          {msg}
        </div>
      )}

      {/* Formulaire d’envoi d’invitations */}
      <div className="rounded-xl border border-zinc-700 bg-zinc-800/60 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <label className="block text-sm text-zinc-300">
            Collez des emails (séparés par virgule, point-virgule ou retour à la ligne)
          </label>
          <div className="text-xs text-zinc-400">Connecté en tant que {meEmail ?? '—'}</div>
        </div>

        <textarea
          className="w-full min-h-32 rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-100 p-3 placeholder-zinc-500"
          placeholder={`ex:\nprenom1.nom@exemple.com\nprenom2@exemple.com, prenom3@exemple.com`}
          value={emailsText}
          onChange={(e) => setEmailsText(e.target.value)}
        />

        <div className="flex items-center gap-2">
          <button
            onClick={sendInvites}
            disabled={sending || !token}
            className="px-4 py-2 rounded-lg border border-blue-500 text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50"
          >
            {sending ? 'Envoi…' : 'Envoyer les invitations'}
          </button>
          <button
            onClick={reload}
            disabled={loadingList || !token}
            className="px-3 py-2 rounded-lg border border-zinc-600 text-zinc-100 hover:bg-zinc-700 disabled:opacity-50"
          >
            {loadingList ? 'Chargement…' : 'Rafraîchir'}
          </button>
          <div className="ml-auto text-xs text-zinc-400">
            {periodSummary}
          </div>
        </div>
      </div>

      {/* Tableau */}
      <div className="rounded-xl border border-zinc-700 bg-zinc-900/50 overflow-x-auto">
        <table className="min-w-full text-sm text-zinc-200">
          <thead className="bg-zinc-800/70 text-zinc-300">
            <tr>
              <th className="text-left p-2">Email</th>
              <th className="text-left p-2">Profil</th>
              <th className="text-left p-2">Invite</th>
              <th className="text-left p-2">Utilisateur</th>
              <th className="text-left p-2">Période (validations)</th>
              <th className="text-right p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={6} className="p-4 text-center text-zinc-400">Aucune donnée</td></tr>
            )}
            {rows.map((r) => {
              const fullName = r.profile
                ? `${r.profile.first_name ?? ''} ${r.profile.last_name ?? ''}`.trim() || '—'
                : (r.invite.full_name || '—');
              const status = r.invite.status;

              return (
                <tr key={r.email} className="border-t border-zinc-800">
                  <td className="p-2">
                    <div className="font-medium">{r.email}</div>
                    <div className="text-xs text-zinc-400">{r.profile?.role ?? r.invite.role ?? '—'}</div>
                  </td>
                  <td className="p-2">
                    <div>{fullName}</div>
                  </td>
                  <td className="p-2">
                    <div className="flex flex-col gap-0.5">
                      <div>
                        Statut : <span className={`px-1.5 py-0.5 rounded text-xs ${
                          status === 'accepted' ? 'bg-emerald-700/30 border border-emerald-700/40' :
                          status === 'revoked'  ? 'bg-red-700/30 border border-red-700/40' :
                          status === 'sent'     ? 'bg-blue-700/30 border border-blue-700/40' :
                          status === 'pending'  ? 'bg-zinc-700/30 border border-zinc-700/40' :
                          'bg-zinc-800/50 border border-zinc-700/40'
                        }`}>{status}</span>
                      </div>
                      <div className="text-xs text-zinc-400">Invité: {fmt(r.invite.invited_at)}</div>
                      <div className="text-xs text-zinc-400">Dernier envoi: {fmt(r.invite.last_sent_at)}</div>
                      <div className="text-xs text-zinc-400">Accepté: {fmt(r.invite.accepted_at)}</div>
                      <div className="text-xs text-zinc-400">Révoqué: {fmt(r.invite.revoked_at)}</div>
                    </div>
                  </td>
                  <td className="p-2">
                    {r.user ? (
                      <div className="flex flex-col gap-0.5">
                        <div className="text-xs text-zinc-300">Créé: {fmt(r.user.created_at)}</div>
                        <div className="text-xs text-zinc-300">Confirmé: {fmt(r.user.confirmed_at)}</div>
                        <div className="text-xs text-zinc-300">Dernier login: {fmt(r.user.last_sign_in_at)}</div>
                      </div>
                    ) : <span className="text-zinc-500">—</span>}
                  </td>
                  <td className="p-2">
                    {r.period?.id ? (
                      <div className="text-xs">
                        <div>{r.period.label ?? 'Période courante'}</div>
                        <div>{r.period.months_validated}/{r.period.months_total} mois validés</div>
                        <div>
                          {r.period.all_validated ? '✅ tout validé' : '⏳ en cours'} {r.period.opted_out ? '• opt-out' : ''}
                        </div>
                      </div>
                    ) : <span className="text-zinc-500">—</span>}
                  </td>
                  <td className="p-2 text-right">
                    {status === 'not_invited' ? (
                      <button
                        onClick={() => doInvite(r.email)}
                        className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500"
                      >
                        Inviter
                      </button>
                    ) : (
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => doResend(r.email)}
                          disabled={status === 'revoked' || status === 'accepted'}
                          className="px-3 py-1.5 rounded bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50"
                        >
                          Renvoyer
                        </button>
                        <button
                          onClick={() => doRevoke(r.email)}
                          disabled={status === 'revoked' || status === 'accepted'}
                          className="px-3 py-1.5 rounded bg-red-700 hover:bg-red-600 disabled:opacity-50"
                        >
                          Révoquer
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

                        <button
                          onClick={() => actionResend(r.email)}
                          className="px-2 py-1 rounded border border-blue-500 text-white bg-blue-600 hover:bg-blue-500 text-xs"
                        >
                          Réinviter
                        </button>
                      )}
                      {(r.invite.status !== 'revoked') && (
                        <button
                          onClick={() => actionRevoke(r.email)}
                          className="px-2 py-1 rounded border border-red-500 text-red-200 hover:bg-red-900/30 text-xs"
                        >
                          Révoquer
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
