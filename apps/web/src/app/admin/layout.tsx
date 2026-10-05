import Link from 'next/link';
import type { ReactNode } from 'react';
import { requireMasterSession } from './_lib/require-master';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireMasterSession();
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <nav aria-label="Admin" className="mb-6 flex gap-4 text-sm font-medium">
        <Link href="/admin">Roster</Link>
        <Link href="/admin/classifiers">Classifiers</Link>
      </nav>
      {children}
    </div>
  );
}
