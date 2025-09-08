// app/admin/tests/page.tsx
export const dynamic = 'force-dynamic';
export const revalidate = 0;

import TestsClient from './TestsClient';

export default function Page() {
  return <TestsClient />;
}
