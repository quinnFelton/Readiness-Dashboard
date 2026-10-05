'use client';

export default function AdminError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert" className="rounded border border-red-400 p-4">
      <p className="font-medium">Couldn&apos;t load this admin page.</p>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        The API may be unavailable, or your session may lack access.
      </p>
      <button type="button" onClick={reset} className="mt-2 rounded border px-3 py-1 text-sm">
        Try again
      </button>
    </div>
  );
}
