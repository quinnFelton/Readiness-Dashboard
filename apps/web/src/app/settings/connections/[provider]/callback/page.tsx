import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { apiFetch } from '@/lib/auth/api-fetch';
import {
  type CallbackQuery,
  completeOAuthCallback,
  signInRedirectFor,
} from '../../../_lib/callback';

export const dynamic = 'force-dynamic';

// Phase 6c: the web app owns the Oura/Strava redirect. Runs server-side so the Bearer token and
// the one-time `code` never touch client JS, logs, or analytics. Nothing here logs the query.
export default async function OAuthCallbackPage({
  params,
  searchParams,
}: {
  params: Promise<{ provider: string }>;
  searchParams: Promise<CallbackQuery>;
}) {
  const [{ provider }, query] = await Promise.all([params, searchParams]);

  const session = await auth();
  if (!session?.user) redirect(signInRedirectFor(provider, query));

  const outcome = await completeOAuthCallback(provider, query, apiFetch);
  if (outcome.status === 'success') {
    redirect(`/settings/connections?connected=${encodeURIComponent(provider)}`);
  }

  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <h1 className="text-xl font-semibold">
        {outcome.status === 'denied' ? 'Connection cancelled' : 'Connection failed'}
      </h1>
      <p role="alert" className="mt-3">
        {outcome.message}
      </p>
      <Link
        href="/settings/connections"
        className="mt-6 inline-block rounded bg-slate-900 px-3 py-2 text-white dark:bg-slate-100 dark:text-slate-900"
      >
        Try again
      </Link>
    </main>
  );
}
