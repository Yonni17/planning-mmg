'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type Period = { id: string; label: string };

export default function PreferencesPage() {
  const [userId, setUserId] = useState<string | null>(null);

  // Identité
  const [firstName, setFirstName] = useState('');
  const [lastName,  setLastName]  = useState('');
  const identityOK = firstName.trim().length > 0 && lastName.trim().length > 0;

  // Période + target
  const [periods, setPeriods] = useState<Period[]>([]);
  const [periodId, setPeriodId] = useState<string>('');
  const [targetLevel, setTargetLevel] = useState<number>(3);

  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(false);
  const [savingPref, setSavingPref] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { window.location.href = '/login'; return; }
      setUserId(user.id);

      // Charger profil (first/last)
      const { data: prof, error: pErr } = await supabase
        .from('profiles')
        .select('first_name, last_name')
        .eq('user_id', user.id)
        .maybeSingle();
      if (!pErr && prof) {
        setFirstName(prof.first_name ?? '');
        setLastName(prof.last_name ?? '');
      }

      // Charger périodes
      const { data: per, error: ePer } = await supabase
        .from('periods').select('id,label').order('open_at', { ascending: false });
      if (!ePer && per) {
        setPeriods(per);
        const def = per[0]?.id ?? '';
        setPeriodId(def);

        if (def) {
          // Charger target existante
          const { data: pref, error: prErr } = await supabase
            .from('preferences_period')
            .select('target_level')
            .eq('user_id', user.id)
            .eq('period_id', def)
            .maybeSingle();
          if (!prErr && pref?.target_level) setTargetLevel(pref.target_level);
        }
      }

      setLoading(false);
    })();
  }, []);

  async function saveIdentity() {
    if (!userId) return;
    setSavingId(true);
    setMsg(null);
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ first_name: firstName.trim(), last_name: lastName.trim() })
        .eq('user_id', userId);
      if (error) throw error;
      setMsg('✅ Identité enregistrée.');
    } catch (e: any) {
      setMsg(`❌ ${e.message ?? 'Erreur enregistrement identité'}`);
    } finally {
      setSavingId(false);
    }
  }

  async function saveTarget() {
    if (!userId || !periodId) return;
    setSavingPref(true);
    setMsg(null);
    try {
      const { error } = await supabase
        .from('preferences_period')
        .upsert({ user_id: userId, period_id: periodId, target_level: targetLevel }, { onConflict: 'user_id,period_id' });
      if (error) throw error;
      setMsg('✅ Préférences enregistrées.');
    } catch (e: any) {
      setMsg(`❌ ${e.message ?? 'Erreur enregistrement préférences'}`);
    } finally {
      setSavingPref(false);
    }
  }

  if (loading) return <div className="p-4 text-zinc-300">Chargement…</div>;

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-8 text-zinc-200">
      <h1 className="text-2xl font-semibold">Mes préférences</h1>

      {msg && (
        <div className={`p-3 rounded border ${msg.startsWith('✅')
          ? 'border-green-700 bg-green-900/30 text-green-200'
          : 'border-red-700 bg-red-900/30 text-red-200'}`}>
          {msg}
        </div>
      )}

      {/* Étape 1 — Identité */}
      <section className="rounded-xl border border-zinc-700 bg-zinc-800/60 p-4 space-y-3">
        <h2 className="text-lg font-medium">1) Mon identité</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Prénom</label>
            <input
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-100 px-3 py-2"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              placeholder="ex: Alice"
            />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Nom</label>
            <input
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-100 px-3 py-2"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              placeholder="ex: Martin"
            />
          </div>
        </div>
        <div className="pt-2">
          <button
            onClick={saveIdentity}
            disabled={savingId || !identityOK}
            className="px-4 py-2 rounded-lg border border-blue-500 text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50"
          >
            {savingId ? 'Enregistrement…' : 'Confirmer mon identité'}
          </button>
        </div>
        {!identityOK && (
          <p className="text-xs text-zinc-400">⚠️ Saisissez votre prénom et votre nom pour accéder à vos préférences.</p>
        )}
      </section>

      {/* Étape 2 — Cible (affichée uniquement si identité OK) */}
      <section className={`rounded-xl border border-zinc-700 p-4 space-y-3 ${identityOK ? 'bg-zinc-800/60' : 'bg-zinc-900/50 opacity-60 pointer-events-none'}`}>
        <h2 className="text-lg font-medium">2) Ma cible de gardes </h2>

        <div className="flex flex-wrap gap-2 items-center">
          <label className="text-sm text-zinc-400">Période</label>
          <select
            className="border border-zinc-700 bg-zinc-900 text-zinc-100 rounded px-3 py-2"
            value={periodId}
            onChange={async (e) => {
              const pid = e.target.value;
              setPeriodId(pid);
              // recharger la valeur de cible pour cette période
              if (userId && pid) {
                const { data: pref } = await supabase
                  .from('preferences_period')
                  .select('target_level')
                  .eq('user_id', userId)
                  .eq('period_id', pid)
                  .maybeSingle();
                setTargetLevel(pref?.target_level ?? 3);
              }
            }}
          >
            {periods.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </div>

        <div>
          <label className="block text-sm text-zinc-400 mb-1">Nombre de gardes souhaité par mois</label>
          <div className="flex flex-wrap gap-2">
            {[1,2,3,4,5].map(n => (
              <button
                key={n}
                onClick={() => setTargetLevel(n)}
                className={[
                  'px-3 py-1.5 rounded-lg border',
                  targetLevel === n
                    ? 'bg-green-600 border-green-500 text-white'
                    : 'bg-zinc-900 border-zinc-700 text-zinc-200 hover:bg-zinc-800'
                ].join(' ')}
              >
                {n === 5 ? 'Max' : n}
              </button>
            ))}
          </div>
        </div>

        <div className="pt-2">
          <button
            onClick={saveTarget}
            disabled={savingPref || !periodId}
            className="px-4 py-2 rounded-lg border border-emerald-500 text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50"
          >
            {savingPref ? 'Enregistrement…' : 'Enregistrer ma cible'}
          </button>
        </div>
      </section>
    </div>
  );
}
