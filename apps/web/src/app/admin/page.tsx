import { RosterTable } from '../../components/admin/RosterTable';
import { parseSort } from '../../components/admin/roster';
import { fetchRoster } from './_lib/api';

export default async function AdminRosterPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; dir?: string }>;
}) {
  const sp = await searchParams;
  const { key, dir } = parseSort(sp.sort, sp.dir);
  const rows = await fetchRoster(); // throws -> error.tsx
  return (
    <main>
      <h1 className="mb-4 text-2xl font-semibold">Athletes</h1>
      <RosterTable rows={rows} sort={key} dir={dir} />
    </main>
  );
}
