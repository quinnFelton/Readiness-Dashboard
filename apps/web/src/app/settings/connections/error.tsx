'use client';

// Deliberately does not render or log error.message (may contain provider/query fragments).
export default function ConnectionsError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <p role="alert" className="text-red-600 dark:text-red-400">
        Something went wrong loading your connections.
      </p>
      <button type="button" onClick={reset} className="mt-3 rounded border px-3 py-1.5">
        Try again
      </button>
    </main>
  );
}
