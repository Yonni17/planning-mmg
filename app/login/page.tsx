'use client';

import { useState } from 'react';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setOk(false);
    setSending(true);

    try {
      const res = await fetch('/api/auth/send-magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      const json = await res.json();

      if (!res.ok) {
        // ❌ échec -> on réactive le bouton
        setMsg(json?.error || 'Échec de l’envoi du lien.');
        setSending(false);
        return;
      }

      // ✅ succès -> on affiche le message et on peut laisser le bouton désactivé
      setOk(true);
      setMsg("Lien de connexion envoyé ! Vérifiez votre boîte mail.");
      setSending(false);
    } catch (err: any) {
      setMsg(err?.message || 'Erreur réseau.');
      setSending(false); // important : réactiver le bouton en cas d’erreur
    }
  }

  return (
    <div className="min-h-[60vh] flex items-center justify-center bg-zinc-950">
      <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-xl">
        <h1 className="text-xl font-semibold text-white mb-2">Connexion</h1>
        <p className="text-sm text-zinc-400 mb-4">
          Entrez votre email pour recevoir un lien magique.
        </p>

        {msg && (
          <div
            className={[
              'mb-4 rounded-lg border px-3 py-2 text-sm',
              ok
                ? 'border-emerald-700 bg-emerald-900/30 text-emerald-200'
                : 'border-red-700 bg-red-900/30 text-red-200',
            ].join(' ')}
          >
            {msg}
          </div>
        )}

        <form onSubmit={handleSend} className="space-y-3">
          <input
            type="email"
            required
            placeholder="ex: prenom.nom@exemple.com"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />

          <button
            type="submit"
            disabled={sending}
            className={[
              'w-full rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              sending
                ? 'bg-zinc-700 text-zinc-300 cursor-not-allowed'
                : 'bg-blue-600 hover:bg-blue-500 text-white',
            ].join(' ')}
          >
            {sending ? 'Envoi…' : 'Envoyer le lien de connexion'}
          </button>
        </form>
      </div>
    </div>
  );
}
