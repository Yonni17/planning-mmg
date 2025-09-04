// mapping heure par type de créneau
const KIND_TIME: Record<string, [string, string]> = {
  WEEKDAY_20_00: ["20:00", "00:00"],
  SAT_12_18:     ["12:00", "18:00"],
  SAT_18_00:     ["18:00", "00:00"],
  SUN_08_14:     ["08:00", "14:00"],
  SUN_14_20:     ["14:00", "20:00"],
  SUN_20_24:     ["20:00", "00:00"],
};

// "2025-10-01" -> "Mercredi 1er octobre"
function formatDateLongFR(ymd?: string | null) {
  if (!ymd) return "—";
  const d = new Date(`${ymd}T00:00:00`);
  const day = d.toLocaleDateString("fr-FR", { weekday: "long" });
  const month = d.toLocaleDateString("fr-FR", { month: "long" });
  const dd = d.getDate();
  const ddStr = dd === 1 ? "1er" : String(dd);
  // Majuscule au jour, mois en minuscule
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return `${cap(day)} ${ddStr} ${month}`;
}

// "WEEKDAY_20_00" -> "20h00 - 00h00"
function formatKindRange(kind?: string | null) {
  if (!kind) return "—";
  const t = KIND_TIME[kind];
  if (!t) return kind;
  const [a, b] = t;
  const h = (s: string) => s.replace(":", "h");
  return `${h(a)} - ${h(b)}`;
}
