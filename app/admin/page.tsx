// app/admin/page.tsx
import Link from 'next/link';

export default function AdminHome() {
  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-semibold text-white">Espace administrateur</h1>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <Link
          href="/admin/slots"
          className="block rounded-xl border border-zinc-700 bg-zinc-800/60 p-6 text-center hover:bg-zinc-800 hover:border-blue-500 transition-colors"
        >
          <h2 className="text-lg font-semibold text-white mb-2">Gestion des créneaux</h2>
          <p className="text-sm text-zinc-400">
            Créer une période, générer les slots et configurer les disponibilités.
          </p>
        </Link>

        <Link
          href="/admin/planning"
          className="block rounded-xl border border-zinc-700 bg-zinc-800/60 p-6 text-center hover:bg-zinc-800 hover:border-blue-500 transition-colors"
        >
          <h2 className="text-lg font-semibold text-white mb-2">Planning : génération & édition</h2>
          <p className="text-sm text-zinc-400">
            Générer le planning, éditer les affectations et enregistrer en base.
          </p>
        </Link>

        <Link
          href="/admin/invites"
          className="block rounded-xl border border-zinc-700 bg-zinc-800/60 p-6 text-center hover:bg-zinc-800 hover:border-blue-500 transition-colors"
        >
          <h2 className="text-lg font-semibold text-white mb-2">Invitations médecins</h2>
          <p className="text-sm text-zinc-400">
            Inviter de nouveaux médecins, renvoyer un lien magique ou révoquer une invitation.
          </p>
        </Link>
        <Link
          href="/admin/automation-settings"
          className="block rounded-xl border border-zinc-700 bg-zinc-800/60 p-6 text-center hover:bg-zinc-800 hover:border-blue-500 transition-colors"
          >
            <h2 className="text-lg font-semibold text-white mb-2">Paramètres & Rappels</h2>
              <p className="text-sm text-zinc-400">
                Délais d’ouverture/fermeture des dispos, rappels automatiques et verrouillage.
              </p>
        </Link>
        <Link
          href="/admin/tests"
          className="block rounded-xl border border-zinc-700 bg-zinc-800/60 p-6 text-center hover:bg-zinc-800 hover:border-blue-500 transition-colors"
        >
          <h2 className="text-lg font-semibold text-white mb-2">Tests & Diagnostics</h2>
          <p className="text-sm text-zinc-400">
            Lancer des checks rapides (slots, dispos, cibles, assignations, réglages auto).
          </p>
        </Link>
      </div>
    </div>
  );
}
