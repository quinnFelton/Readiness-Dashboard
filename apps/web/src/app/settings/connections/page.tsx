import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { ConnectionsPanel } from '@/components/settings/ConnectionsPanel';
import { loadOverview } from '../_lib/server';
import type { ConnectionsOverview } from '../_lib/types';

export const dynamic = 'force-dynamic';

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; status?: string }>;
}) {
  // Server-side gate (never nav-hiding alone); the API re-authorises every call too.
  const session = await auth();
  if (!session?.user) redirect('/login?callbackUrl=%2Fsettings%2Fconnections');

  const sp = await searchParams;
  let overview: ConnectionsOverview | null = null;
  let failed = false;
  try {
    overview = await loadOverview();
  } catch {
    failed = true;
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
      {sp.connected && (
        <p role="status" className="mt-4 rounded border border-green-600/50 p-3 text-sm">
          {sp.connected} connected successfully.
        </p>
      )}
      {sp.status === 'success' && !sp.connected && (
        <p role="status" className="mt-4 rounded border border-green-600/50 p-3 text-sm">
          Connection updated.
        </p>
      )}
      <div className="mt-6">
        {failed || !overview ? (
          <p role="alert" className="text-red-600 dark:text-red-400">
            We couldn’t load your connections. Please refresh to try again.
          </p>
        ) : overview.connections.length === 0 ? (
          <>
            <p className="mb-4 opacity-70">
              No connections yet. Connect a source below to start building your trend.
            </p>
            <ConnectionsPanel overview={overview} />
          </>
        ) : (
          <ConnectionsPanel overview={overview} />
        )}
      </div>
    </main>
  );
}
