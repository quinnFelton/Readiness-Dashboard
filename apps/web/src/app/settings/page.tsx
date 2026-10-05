import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// Terra's widget returns here (TERRA_SUCCESS/FAILURE_REDIRECT_URL = /settings); show its status.
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/login?callbackUrl=%2Fsettings');
  const { status } = await searchParams;
  const failed = status === 'failure' || status === 'error';

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      {status && (
        <p role={failed ? 'alert' : 'status'} className="mt-4 rounded border p-3 text-sm">
          {failed
            ? 'Connecting your Zepp account did not complete. Please try again.'
            : 'Your Zepp account connection was submitted. Data will appear after the first sync.'}
        </p>
      )}
      <Link href="/settings/connections" className="mt-6 inline-block underline">
        Manage connections
      </Link>
    </main>
  );
}
