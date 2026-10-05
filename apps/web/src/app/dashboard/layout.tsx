import Link from 'next/link';
import type { ReactNode } from 'react';

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Readiness</h1>
        <nav aria-label="Dashboard" className="flex gap-4 text-sm">
          <Link href="/dashboard" className="underline-offset-4 hover:underline">
            Overview
          </Link>
          <Link href="/dashboard/trends" className="underline-offset-4 hover:underline">
            Trends
          </Link>
          <Link href="/settings/connections" className="underline-offset-4 hover:underline">
            Connections
          </Link>
        </nav>
      </header>
      {children}
    </main>
  );
}
