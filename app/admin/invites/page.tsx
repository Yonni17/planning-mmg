'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export default function AdminInvitationsPage() {
  const [emailsText, setEmailsText] = useState('');
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [meEmail, setMeEmail] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      setMeEmail(session?.user?.email ?? null);
    })();
  }, []);

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
    setSending(true);
    setMsg(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Session invalide — reconnectez-vous.');

      const res = await fetch('/api/admin/invites', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`, // ⬅️ IMPORTANT
        },
        body: JSON.stringify({
          emails,
          // tu peux aussi passer un nom affiché ou un rôle si tu veux les pré-créer dans profiles
          role: 'doctor',
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? 'Erreur serveur');

      setMsg(`✅ Invitations envoyées : ${json.sent} (ignorés: ${json.skipped})`);
      setEmailsText('');
    } catch (e: any) {
      setMsg(`❌ ${e.message ?? 'Échec envoi'}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-semibold text-white">Invitations médecins</h1>

      {msg && (
        <div className={`p-3 rounded border ${msg.startsWith('✅') ? 'border-green-700 bg-green-900/30 text-green-200' : 'border-red-700 bg-red-900/30 text-red-200'}`}>
          {msg}
        </div>
      )}

      <div className="rounded-xl border border-zinc-700 bg-zinc-800/60 p-4 space-y-3">
        <label className="block text-sm text-zinc-300">
          Collez une liste d’emails (séparés par virgule, point-virgule ou retour à la ligne)
        </label>
        <textarea
          className="w-full min-h-40 rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-100 p-3 placeholder-zinc-500"
          placeholder={`ex:\nprenom1.nom1@exemple.com\nprenom2@exemple.com, prenom3@exemple.com`}
          value={emailsText}
          onChange={(e) => setEmailsText(e.target.value)}
        />
        <div className="flex items-center justify-between">
          <div className="text-xs text-zinc-400">
            Connecté en tant que {meEmail ?? '—'}
          </div>
          <button
            onClick={sendInvites}
            disabled={sending}
            className="px-4 py-2 rounded-lg border border-blue-500 text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50"
          >
            {sending ? 'Envoi…' : 'Envoyer les invitations'}
          </button>
        </div>
      </div>

      <p className="text-xs text-zinc-400">
        Les invités recevront un <strong>lien magique</strong> (PKCE) menant vers <code>/auth/callback</code>.
        Assure-toi que l’URL est bien configurée dans Supabase (Site URL &amp; Additional Redirect URLs).
      </p>
    </div>
  );
}
