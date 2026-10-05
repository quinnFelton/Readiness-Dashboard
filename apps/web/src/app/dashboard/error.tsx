'use client'; // Error boundaries must be Client Components

// Deliberately does not log the error: it could carry health data (CLAUDE.md rule 6).
export default function DashboardError({ retry }: { error: Error; retry: () => void }) {
  return (
    <section
      role="alert"
      className="rounded-lg border border-red-300 bg-red-50 p-4 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100"
    >
      <h2 className="font-semibold">Something went wrong</h2>
      <p className="mt-1 text-sm">We could not load your dashboard.</p>
      <button type="button" onClick={() => retry()} className="mt-2 text-sm underline">
        Try again
      </button>
    </section>
  );
}
