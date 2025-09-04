// app/admin/slots/page.tsx
'use client';

import { useState } from 'react';

type Payload = {
  label: string;
  startDate: string;   // YYYY-MM-DD
  endDate: string;     // YYYY-MM-DD
  openAt: string;      // YYYY-MM-DDTHH:mm
  closeAt?: string;    // optionnel
  generateAt?: string; // optionnel
  timezone?: string;   // ex: Europe/Paris
  holidays?: string[]; // YYYY-MM-DD (un par ligne côté UI)
  autoHolidays?: boolean;
};

export default function AdminSlotsPage() {
  const [holidaysText, setHolidaysText] = useState<string>('');
  const [autoHolidays, setAutoHolidays] = useState<boolean>(true);
  const [payload, setPayload] = useState<Payload>({
    label: 'T4 2025',
    startDate: '2025-10-01',
    endDate: '2025-12-31',
    openAt: '2025-09-15T08:00',
    closeAt: '2025-09-30T23:59',
    generateAt: '2025-10-01T08:00',
    timezone: 'Europe/Paris',
  });

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setPayload(p => ({ ...p, [name]: value }));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setResult(null);

    const holidays = holidaysText
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean);

    try {
      const res = await fetch('/api/admin/generate-slots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          holidays,
          autoHolidays,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erreur API');
      setResult(`✅ Période créée (${data.period_id}). Slots générés : ${data.slots_created}.`);
    } catch (err: any) {
      setResult(`❌ ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <h1 className="text-2xl font-semibold">Générer un trimestre & créneaux</h1>

      <form onSubmit={submit} className="space-y-5">
        <div className="grid sm:grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm text-gray-600">Label de la période</span>
            <input
              name="label"
              value={payload.label}
              onChange={onChange}
              className="border rounded p-2 w-full"
              required
            />
          </label>

          <label className="block">
            <span className="text-sm text-gray-600">Fuseau horaire (info)</span>
            <input
              name="timezone"
              value={payload.timezone}
              onChange={onChange}
              className="border rounded p-2 w-full"
              required
            />
          </label>

          <label className="block">
            <span className="text-sm text-gray-600">Début (inclus)</span>
            <input
              type="date"
              name="startDate"
              value={payload.startDate}
              onChange={onChange}
              className="border rounded p-2 w-full"
              required
            />
          </label>

          <label className="block">
            <span className="text-sm text-gray-600">Fin (inclus)</span>
            <input
              type="date"
              name="endDate"
              value={payload.endDate}
              onChange={onChange}
              className="border rounded p-2 w-full"
              required
            />
          </label>

          <label className="block">
            <span className="text-sm text-gray-600">Ouverture saisie</span>
            <input
              type="datetime-local"
              name="openAt"
              value={payload.openAt}
              onChange={onChange}
              className="border rounded p-2 w-full"
              required
            />
          </label>

          <label className="block">
            <span className="text-sm text-gray-600">Clôture saisie (info)</span>
            <input
              type="datetime-local"
              name="closeAt"
              value={payload.closeAt}
              onChange={onChange}
              className="border rounded p-2 w-full"
            />
          </label>

          <label className="block sm:col-span-2">
            <span className="text-sm text-gray-600">Date/heure de génération (info)</span>
            <input
              type="datetime-local"
              name="generateAt"
              value={payload.generateAt}
              onChange={onChange}
              className="border rounded p-2 w-full"
            />
          </label>
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={autoHolidays}
              onChange={(e) => setAutoHolidays(e.target.checked)}
            />
            <span className="text-sm text-gray-800">
              Ajouter automatiquement les jours fériés français (traités comme des dimanches)
            </span>
          </label>

          <label className="block">
            <span className="text-sm text-gray-600">Jours fériés manuels (YYYY-MM-DD, un par ligne)</span>
            <textarea
              rows={5}
              value={holidaysText}
              onChange={(e) => setHolidaysText(e.target.value)}
              className="border rounded p-2 w-full"
              placeholder={'2025-11-01\n2025-11-11\n2025-12-25'}
            />
          </label>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 shadow"
        >
          {loading ? 'Génération…' : 'Générer la période et les créneaux'}
        </button>
      </form>

      {result && (
        <div
          className={`p-3 rounded border ${
            result.startsWith('✅')
              ? 'bg-green-50 border-green-200 text-green-900'
              : 'bg-red-50 border-red-200 text-red-900'
          }`}
        >
          {result}
        </div>
      )}

      <p className="text-sm text-gray-600">
        Règles : lun–ven 20–00, sam 12–18 & 18–00, dim/feriés 08–14, 14–20, 20–24 (00:00 = lendemain).
      </p>
    </div>
  );
}
