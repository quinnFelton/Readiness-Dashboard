export default function Loading() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10" aria-busy="true">
      <div className="h-8 w-48 animate-pulse rounded bg-slate-300/50" />
      <div className="mt-6 space-y-3">
        <div className="h-20 animate-pulse rounded bg-slate-300/40" />
        <div className="h-20 animate-pulse rounded bg-slate-300/40" />
      </div>
    </main>
  );
}
