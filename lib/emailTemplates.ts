// lib/emailTemplates.ts
// Templates d’emails pro, sobres et compatibles clients mail.
// Couleurs : vert MMG (#047857), ton sobre gris foncé.

type BaseOpts = {
  title: string;
  preheader?: string;
  contentHtml: string;
  primaryCta?: { href: string; label: string };
  secondaryCta?: { href: string; label: string };
  footerNote?: string;
  brand?: string;
  supportEmail?: string;
};

const BRAND = 'MMG – Maison Médicale de Garde';

function layout({
  title,
  preheader = '',
  contentHtml,
  primaryCta,
  secondaryCta,
  footerNote,
  brand = BRAND,
  supportEmail = 'planning@send.planning-mmg.ovh',
}: BaseOpts) {
  // HTML simple table-based + styles inline (meilleure compatibilité)
  return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width" />
  <title>${escapeHtml(title)}</title>
  <style>
    /* fallback pour quelques clients web */
    a { text-decoration: none; }
  </style>
</head>
<body style="margin:0;padding:0;background:#f6f7f9">
  <!-- preheader (caché) -->
  <div style="display:none;overflow:hidden;line-height:1px;opacity:0;color:transparent;height:0;max-height:0">
    ${escapeHtml(preheader)}
  </div>

  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f7f9;padding:24px 0">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" role="presentation" style="width:600px;max-width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
          <!-- Header -->
          <tr>
            <td style="background:#065f46;padding:18px 24px;color:#ffffff;font-family:Segoe UI,Arial,sans-serif;font-size:18px;font-weight:600;">
              ${escapeHtml(brand)}
            </td>
          </tr>

          <!-- Titre -->
          <tr>
            <td style="padding:24px 24px 0 24px;font-family:Segoe UI,Arial,sans-serif;">
              <h1 style="margin:0 0 8px 0;font-size:20px;line-height:28px;color:#111827;">${escapeHtml(title)}</h1>
            </td>
          </tr>

          <!-- Corps -->
          <tr>
            <td style="padding:8px 24px 8px 24px;font-family:Segoe UI,Arial,sans-serif;color:#374151;font-size:14px;line-height:22px;">
              ${contentHtml}
            </td>
          </tr>

          <!-- CTAs -->
          ${(primaryCta || secondaryCta) ? `
          <tr>
            <td style="padding:8px 24px 24px 24px;font-family:Segoe UI,Arial,sans-serif;">
              ${primaryCta ? `
              <a href="${primaryCta.href}"
                 style="display:inline-block;background:#047857;color:#ffffff;padding:10px 16px;border-radius:8px;font-weight:600;font-size:14px;">
                 ${escapeHtml(primaryCta.label)}
              </a>` : ''}

              ${secondaryCta ? `
              <a href="${secondaryCta.href}"
                 style="display:inline-block;margin-left:12px;background:#f3f4f6;color:#111827;padding:10px 16px;border-radius:8px;font-weight:600;font-size:14px;border:1px solid #e5e7eb;">
                 ${escapeHtml(secondaryCta.label)}
              </a>` : ''}
            </td>
          </tr>
          ` : ''}

          <!-- Footer -->
          <tr>
            <td style="padding:16px 24px 24px 24px;font-family:Segoe UI,Arial,sans-serif;color:#6b7280;font-size:12px;line-height:18px;border-top:1px solid #f3f4f6;">
              ${footerNote ? `<p style="margin:0 0 8px 0;">${footerNote}</p>` : ''}
              <p style="margin:0;">Besoin d’aide ? Écrivez-nous : <a href="mailto:${supportEmail}" style="color:#047857;">${supportEmail}</a></p>
            </td>
          </tr>
        </table>

        <div style="font-family:Segoe UI,Arial,sans-serif;color:#9ca3af;font-size:11px;line-height:16px;margin-top:12px;">
          Vous recevez cet e-mail car vous faites partie des utilisateurs de ${escapeHtml(brand)}.
        </div>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const tz = 'Europe/Paris';
function fmtDate(d?: Date | null, withTime = true) {
  if (!d) return '—';
  return d.toLocaleString('fr-FR', {
    timeZone: tz,
    year: 'numeric',
    month: 'long',
    day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

function baseText(lines: string[]) {
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/* =========================
   TEMPLATES SPÉCIFIQUES
   ========================= */

export function emailOpening(opts: {
  name?: string;
  periodLabel?: string;
  openAt?: Date | null;
  deadline?: Date | null;
  siteUrl: string;
}) {
  const title = 'Ouverture de la saisie des disponibilités';
  const pre = 'La saisie est ouverte. Merci d’indiquer vos créneaux avant la date limite.';
  const name = opts.name || 'Docteur';
  const contentHtml = `
    <p>Bonjour ${escapeHtml(name)},</p>
    <p>La saisie de vos disponibilités est <b>désormais ouverte</b>${opts.periodLabel ? ` pour la période <b>${escapeHtml(opts.periodLabel)}</b>` : ''}.</p>
    <ul style="margin:8px 0 12px 18px;padding:0;">
      ${opts.openAt ? `<li>Ouverture : ${escapeHtml(fmtDate(opts.openAt))}</li>` : ''}
      ${opts.deadline ? `<li>Date limite : <b>${escapeHtml(fmtDate(opts.deadline))}</b></li>` : ''}
    </ul>
    <p>Merci de cocher vos créneaux disponibles. Vous pourrez valider chaque mois quand vous êtes à jour (et le déverrouiller si besoin).</p>
  `;
  const html = layout({
    title,
    preheader: pre,
    contentHtml,
    primaryCta: { href: `${opts.siteUrl}/calendrier`, label: 'Saisir mes disponibilités' },
    secondaryCta: { href: `${opts.siteUrl}/preferences`, label: 'Mes préférences' },
    footerNote: 'Astuce : validez un mois quand vous avez tout coché. Vous pourrez toujours revenir en arrière tant que la période n’est pas verrouillée par l’administration.',
  });

  const text = baseText([
    `Bonjour ${name},`,
    '',
    `La saisie de vos disponibilités est ouverte${opts.periodLabel ? ` pour ${opts.periodLabel}` : ''}.`,
    opts.openAt ? `Ouverture : ${fmtDate(opts.openAt)}` : '',
    opts.deadline ? `Date limite : ${fmtDate(opts.deadline)}` : '',
    '',
    `Saisir mes disponibilités : ${opts.siteUrl}/calendrier`,
    `Mes préférences : ${opts.siteUrl}/preferences`,
  ]);

  const subject = `Ouverture de la saisie ${opts.periodLabel ? `– ${opts.periodLabel}` : ''}`;
  return { subject, html, text };
}

export function emailWeeklyReminder(opts: {
  name?: string;
  periodLabel?: string;
  deadline?: Date | null;
  siteUrl: string;
  pendingMonths?: string[]; // ex.: ['janvier', 'février']
}) {
  const title = 'Rappel hebdomadaire – disponibilités à compléter';
  const pre = 'Petit rappel : il vous reste encore des créneaux à cocher.';
  const name = opts.name || 'Docteur';
  const months = opts.pendingMonths?.length ? ` (${opts.pendingMonths.join(', ')})` : '';
  const contentHtml = `
    <p>Bonjour ${escapeHtml(name)},</p>
    <p>Il vous reste des créneaux à compléter${escapeHtml(months)} pour la période ${escapeHtml(opts.periodLabel || '')}.</p>
    ${opts.deadline ? `<p><b>Date limite :</b> ${escapeHtml(fmtDate(opts.deadline))}</p>` : ''}
    <p>Merci de finaliser la saisie puis de <b>valider les mois</b> concernés.</p>
  `;
  const html = layout({
    title,
    preheader: pre,
    contentHtml,
    primaryCta: { href: `${opts.siteUrl}/calendrier`, label: 'Compléter mes disponibilités' },
    footerNote: `Vous recevez ce rappel tant que des mois ne sont pas validés${opts.deadline ? ` (avant la date limite)` : ''}.`,
  });

  const text = baseText([
    `Bonjour ${name},`,
    '',
    `Rappel : il reste des créneaux à compléter${months} pour ${opts.periodLabel || ''}.`,
    opts.deadline ? `Date limite : ${fmtDate(opts.deadline)}` : '',
    '',
    `Compléter : ${opts.siteUrl}/calendrier`,
  ]);

  const subject = `Rappel – complétez vos disponibilités ${opts.periodLabel ? `(${opts.periodLabel})` : ''}`;
  return { subject, html, text };
}

export function emailDeadline(opts: {
  name?: string;
  periodLabel?: string;
  deadline?: Date | null;
  hoursBefore?: number | null;
  siteUrl: string;
}) {
  const hb = (opts.hoursBefore ?? null) !== null ? `J-${opts.hoursBefore}h – ` : '';
  const title = `${hb}Dernière ligne droite`;
  const pre = `La saisie se termine bientôt${opts.deadline ? ` (${fmtDate(opts.deadline)})` : ''}.`;
  const name = opts.name || 'Docteur';

  const contentHtml = `
    <p>Bonjour ${escapeHtml(name)},</p>
    <p><b>Dernière ligne droite.</b> La saisie des disponibilités${opts.periodLabel ? ` pour <b>${escapeHtml(opts.periodLabel)}</b>` : ''} se termine bientôt${opts.deadline ? ` (échéance : <b>${escapeHtml(fmtDate(opts.deadline))}</b>)` : ''}.</p>
    <p>Merci de finaliser vos créneaux et de <b>valider</b> les mois concernés.</p>
  `;
  const html = layout({
    title,
    preheader: pre,
    contentHtml,
    primaryCta: { href: `${opts.siteUrl}/calendrier`, label: 'Finaliser maintenant' },
  });

  const text = baseText([
    `Bonjour ${name},`,
    '',
    `Dernière ligne droite : la saisie se termine bientôt.`,
    opts.deadline ? `Échéance : ${fmtDate(opts.deadline)}` : '',
    '',
    `Finaliser : ${opts.siteUrl}/calendrier`,
  ]);

  const subject = `${hb}Saisie des disponibilités – dernière étape${opts.periodLabel ? ` (${opts.periodLabel})` : ''}`;
  return { subject, html, text };
}

export function emailPlanningReady(opts: {
  name?: string;
  periodLabel?: string;
  siteUrl: string;
}) {
  const title = 'Planning validé et disponible';
  const pre = 'Votre planning est prêt. Consultez vos gardes et exportez-les si besoin.';
  const name = opts.name || 'Docteur';
  const contentHtml = `
    <p>Bonjour ${escapeHtml(name)},</p>
    <p>Le planning ${opts.periodLabel ? `pour <b>${escapeHtml(opts.periodLabel)}</b> ` : ''}a été <b>validé</b> et est maintenant disponible.</p>
    <p>Vous pouvez le consulter en ligne et l’exporter.</p>
  `;
  const html = layout({
    title,
    preheader: pre,
    contentHtml,
    primaryCta: { href: `${opts.siteUrl}/agenda`, label: 'Voir mon planning' },
  });

  const text = baseText([
    `Bonjour ${name},`,
    '',
    `Le planning ${opts.periodLabel ? `(${opts.periodLabel}) ` : ''}est validé.`,
    `Consulter : ${opts.siteUrl}/agenda`,
  ]);

  const subject = `Planning validé ${opts.periodLabel ? `– ${opts.periodLabel}` : ''}`;
  return { subject, html, text };
}
