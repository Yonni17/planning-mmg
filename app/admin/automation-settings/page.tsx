// app/admin/automation-settings/page.tsx
export const dynamic = 'force-dynamic';
export const revalidate = 0;

import AutomationSettingsClient from './AutomationSettingsClient';

export default function Page() {
  return <AutomationSettingsClient />;
}
