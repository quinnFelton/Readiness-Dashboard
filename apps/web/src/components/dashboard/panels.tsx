// Small presentational pieces shared by the dashboard and trends views (server-safe).
import Link from 'next/link';
import type { ReactNode } from 'react';
import { STATE_META, isStateId } from './state-meta';

export function Card({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section
      aria-labelledby={id}
      className="rounded-lg border border-slate-200 p-4 dark:border-slate-700"
    >
      <h2 id={id} className="mb-3 text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function StateBadge({ state }: { state: string }) {
  const meta = isStateId(state) ? STATE_META[state] : null;
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-medium"
      style={{ borderColor: meta?.color ?? '#64748b' }}
    >
      <span
        aria-hidden
        className="inline-block h-2.5 w-2.5 rounded-full"
        style={{ backgroundColor: meta?.color ?? '#64748b' }}
      />
      {meta?.label ?? state}
    </span>
  );
}

/** New user, or an athlete with nothing synced: point to /settings/connections (self only). */
export function EmptyState({ isSelf }: { isSelf: boolean }) {
  return (
    <section
      role="status"
      aria-labelledby="empty-heading"
      className="rounded-lg border border-dashed border-slate-300 p-8 text-center dark:border-slate-600"
    >
      <h2 id="empty-heading" className="text-lg font-semibold">
        No data yet
      </h2>
      {isSelf ? (
        <>
          <p className="mt-2 text-slate-600 dark:text-slate-300">
            Connect an activity source and a recovery source to see whether you are building fitness
            or carrying fatigue.
          </p>
          <Link
            href="/settings/connections"
            className="mt-4 inline-block rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white"
          >
            Connect your data sources
          </Link>
        </>
      ) : (
        <p className="mt-2 text-slate-600 dark:text-slate-300">
          This athlete has not connected any data sources yet.
        </p>
      )}
    </section>
  );
}

export function ErrorPanel({ message, onRetryHref }: { message: string; onRetryHref?: string }) {
  return (
    <section
      role="alert"
      className="rounded-lg border border-red-300 bg-red-50 p-4 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100"
    >
      <h2 className="font-semibold">Something went wrong</h2>
      <p className="mt-1 text-sm">{message}</p>
      {onRetryHref && (
        <Link href={onRetryHref} className="mt-2 inline-block text-sm underline">
          Reload
        </Link>
      )}
    </section>
  );
}

export function LoadingSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="animate-pulse space-y-4">
      <div className="h-28 rounded-lg bg-slate-200 dark:bg-slate-800" />
      <div className="h-72 rounded-lg bg-slate-200 dark:bg-slate-800" />
      <div className="h-24 rounded-lg bg-slate-200 dark:bg-slate-800" />
    </div>
  );
}
